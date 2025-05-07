const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
let puppeteer;

try {
    puppeteer = require('puppeteer');
} catch (err) {
    console.warn('Puppeteer not installed. Dynamic content rendering will not work.');
}

// Keep a global reference of the window object
let mainWindow = null;
let currentScraper = null;
let lastScrapingResults = [];

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'main.html'));
}

app.whenReady().then(() => {
    createWindow();
    
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// Basic scraper implementation
class BasicScraper {
    constructor(config, sender) {
        this.config = config;
        this.sender = sender;
        this.browser = null;
        this.running = false;
        this.visitedUrls = [];
        this.queue = [];
        this.results = [];
        this.pageCount = 0;
        this.errors = [];
        this.startTime = null;
        this.endTime = null;
        this.totalLinks = 0;
    }
    
    async start() {
        this.running = true;
        this.startTime = Date.now();
        
        try {
            if (!puppeteer) {
                throw new Error('Puppeteer is not installed. Please run "npm install puppeteer" to enable browser scraping.');
            }
            
            // Launch browser with appropriate options
            const puppeteerOptions = {
                headless: this.config.browserOptions?.headless !== false,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            };
            
            this.sender.send('scraping-progress', {
                message: 'Launching browser...',
                level: 'INFO'
            });
            
            this.browser = await puppeteer.launch(puppeteerOptions);
            
            // Add starting URL to queue
            this.queue.push({
                url: this.config.startUrl,
                depth: 0
            });
            
            // Process the queue
            while (this.queue.length > 0 && this.running) {
                // Check if we've reached the max pages
                if (this.config.maxPages && this.pageCount >= this.config.maxPages) {
                    this.sender.send('scraping-progress', {
                        message: `Maximum page limit (${this.config.maxPages}) reached`,
                        level: 'INFO'
                    });
                    break;
                }
                
                // Get next URL from queue
                const { url, depth } = this.queue.shift();
                
                // Skip if already visited
                if (this.visitedUrls.includes(url)) {
                    continue;
                }
                
                // Process this URL
                await this.processUrl(url, depth);
                
                // Add to visited list
                this.visitedUrls.push(url);
                
                // Apply delay between requests if specified
                if (this.config.delay > 0 && this.queue.length > 0) {
                    this.sender.send('scraping-progress', {
                        message: `Waiting ${this.config.delay}ms before next request...`,
                        level: 'INFO'
                    });
                    await new Promise(resolve => setTimeout(resolve, this.config.delay));
                }
            }
            
            // Cleanup
            if (this.browser) {
                await this.browser.close();
            }
            
            // Calculate total time
            this.endTime = Date.now();
            this.totalTime = ((this.endTime - this.startTime) / 1000).toFixed(2);
            
            return this.results;
        } catch (error) {
            this.errors.push({
                message: error.message,
                stack: error.stack,
                time: new Date().toISOString()
            });
            
            this.sender.send('scraping-error', {
                message: error.message
            });
            
            if (this.browser) {
                await this.browser.close();
            }
            
            throw error;
        }
    }
    
    async processUrl(url, depth) {
        try {
            this.sender.send('scraping-progress', {
                currentUrl: url,
                message: `Processing URL: ${url} (depth: ${depth})`,
                level: 'INFO',
                pagesCrawled: this.pageCount,
                totalLinks: this.totalLinks
            });
            
            // Create a new page
            const page = await this.browser.newPage();
            
            // Set user agent if specified
            if (this.config.userAgent) {
                await page.setUserAgent(this.config.userAgent);
            }
            
            // Set custom headers if specified
            if (this.config.customHeaders && Object.keys(this.config.customHeaders).length > 0) {
                await page.setExtraHTTPHeaders(this.config.customHeaders);
            }
            
            // Set timeout
            page.setDefaultNavigationTimeout(this.config.timeout || 30000);
            
            // Navigate to URL
            const response = await page.goto(url, {
                waitUntil: 'networkidle2'
            });
            
            // Check if page loaded successfully
            if (!response || response.status() >= 400) {
                this.errors.push({
                    url,
                    status: response?.status(),
                    message: `Failed to load page: ${response?.statusText() || 'Unknown error'}`,
                    time: new Date().toISOString()
                });
                
                this.sender.send('scraping-progress', {
                    message: `Error loading ${url}: ${response?.status()} ${response?.statusText() || 'Failed to load'}`,
                    level: 'ERROR',
                    error: true
                });
                
                await page.close();
                return;
            }
            
            // Extract data from page
            const pageData = await page.evaluate(() => {
                return {
                    title: document.title,
                    content: document.body.innerText,
                    html: document.documentElement.outerHTML,
                    links: Array.from(document.querySelectorAll('a'))
                        .map(a => a.href)
                        .filter(href => href && href.startsWith('http')),
                    images: Array.from(document.querySelectorAll('img'))
                        .map(img => img.src)
                        .filter(src => src && src.startsWith('http'))
                };
            });
            
            // Add metadata
            pageData.url = url;
            pageData.depth = depth;
            pageData.timestamp = new Date().toISOString();
            pageData.contentType = response.headers()['content-type'] || 'text/html';
            
            // Add to results
            this.results.push(pageData);
            this.pageCount++;
            this.totalLinks += pageData.links.length;
            
            // Send progress update
            this.sender.send('scraping-progress', {
                type: 'page-complete',
                url: url,
                pagesCrawled: this.pageCount,
                totalLinks: this.totalLinks,
                maxPages: this.config.maxPages
            });
            
            // Handle links (if not at max depth)
            if (depth < this.config.maxDepth) {
                this.queueLinks(pageData.links, depth + 1);
            }
            
            // Close the page to free memory
            await page.close();
        } catch (error) {
            this.errors.push({
                url,
                message: error.message,
                stack: error.stack,
                time: new Date().toISOString()
            });
            
            this.sender.send('scraping-progress', {
                message: `Error processing ${url}: ${error.message}`,
                level: 'ERROR',
                error: true
            });
        }
    }
    
    queueLinks(links, depth) {
        // Filter links based on configuration
        links.forEach(link => {
            try {
                // Parse URL
                const parsedUrl = new URL(link);
                const parsedStartUrl = new URL(this.config.startUrl);
                
                // Skip non-http(s) URLs
                if (!parsedUrl.protocol.startsWith('http')) {
                    return;
                }
                
                // Filter by domain if enabled
                if (this.config.filterDomains) {
                    const startHost = parsedStartUrl.hostname;
                    const linkHost = parsedUrl.hostname;
                    
                    if (this.config.includeSubdomains) {
                        // Check if it's a subdomain
                        if (!linkHost.endsWith(startHost.replace(/^www\./, '')) &&
                            !startHost.endsWith(linkHost.replace(/^www\./, ''))) {
                            return;
                        }
                    } else {
                        // Exact domain match required
                        if (linkHost !== startHost) {
                            return;
                        }
                    }
                }
                
                // Normalize URL based on settings
                let normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
                
                // Include query params if not ignoring them
                if (!this.config.ignoreQueryParams) {
                    normalizedUrl += parsedUrl.search;
                }
                
                // Include hash fragment if not ignoring it
                if (!this.config.ignoreHashFragments) {
                    normalizedUrl += parsedUrl.hash;
                }
                
                // Skip if already visited or queued
                if (this.visitedUrls.includes(normalizedUrl) || 
                    this.queue.some(item => item.url === normalizedUrl)) {
                    return;
                }
                
                // Check include patterns
                if (this.config.includePatterns && this.config.includePatterns.length > 0) {
                    const matches = this.config.includePatterns.some(pattern => {
                        try {
                            const regex = new RegExp(pattern);
                            return regex.test(normalizedUrl);
                        } catch (e) {
                            return normalizedUrl.includes(pattern);
                        }
                    });
                    
                    if (!matches) return;
                }
                
                // Check exclude patterns
                if (this.config.excludePatterns && this.config.excludePatterns.length > 0) {
                    const matches = this.config.excludePatterns.some(pattern => {
                        try {
                            const regex = new RegExp(pattern);
                            return regex.test(normalizedUrl);
                        } catch (e) {
                            return normalizedUrl.includes(pattern);
                        }
                    });
                    
                    if (matches) return;
                }
                
                // Add to queue
                this.queue.push({
                    url: normalizedUrl,
                    depth: depth
                });
            } catch (error) {
                console.error('Error processing link:', link, error);
            }
        });
        
        // Update UI with queue status
        this.sender.send('scraping-progress', {
            type: 'queue-update',
            queueSize: this.queue.length
        });
    }
    
    stop() {
        this.running = false;
        if (this.browser) {
            this.browser.close().catch(err => console.error('Error closing browser:', err));
        }
    }
}

// Handle scraping requests from renderer
ipcMain.on('start-scraping', async (event, config) => {
    try {
        console.log('Starting scrape with config:', config);
        
        // Send initial progress update to the renderer
        event.sender.send('scraping-progress', {
            message: `Starting scrape of ${config.startUrl}`,
            level: 'INFO'
        });
        
        // Create a scraper
        currentScraper = new BasicScraper(config, event.sender);
        
        // Start the scraper and get results
        const startTime = Date.now();
        const results = await currentScraper.start();
        
        // Store the results globally for export
        lastScrapingResults = results;
        
        // Handle successful completion
        const win = BrowserWindow.getFocusedWindow();
        if (win) {
            // Calculate media files count
            const mediaFilesCount = results.reduce((sum, page) => {
                return sum + (page.images ? page.images.length : 0);
            }, 0);
            
            win.webContents.send('scraping-complete', {
                pageCount: results.length || 0,
                totalLinks: currentScraper.totalLinks || 0,
                mediaFiles: mediaFilesCount || 0,
                errors: currentScraper.errors || [],
                timeTaken: ((Date.now() - startTime) / 1000).toFixed(2),
                results: results || []
            });
        }
        
        // Clear current scraper reference
        currentScraper = null;
    } catch (error) {
        console.error('Error in scraping process:', error);
        event.sender.send('scraping-error', {
            message: error.message,
            stack: error.stack
        });
        currentScraper = null;
    }
});

// Handle stop request
ipcMain.on('stop-scraping', (event) => {
    if (currentScraper) {
        currentScraper.stop();
        event.sender.send('scraping-progress', {
            message: 'Scraping stopped by user',
            level: 'WARNING'
        });
        currentScraper = null;
    }
});

// Handle export requests
ipcMain.on('export-results', async (event, format) => {
    try {
        if (!lastScrapingResults || lastScrapingResults.length === 0) {
            event.sender.send('scraping-progress', {
                message: 'No results available to export',
                level: 'ERROR'
            });
            return;
        }
        
        // Ask for save location
        const { filePath, canceled } = await dialog.showSaveDialog({
            title: `Save as ${format.toUpperCase()}`,
            defaultPath: `scraping-results.${format}`,
            filters: [
                { name: format === 'json' ? 'JSON Files' : 'CSV Files', extensions: [format] }
            ]
        });
        
        if (canceled || !filePath) {
            return;
        }
        
        // Export based on format
        if (format === 'json') {
            await fs.promises.writeFile(
                filePath,
                JSON.stringify(lastScrapingResults, null, 2),
                'utf8'
            );
        } else if (format === 'csv') {
            // Get all unique keys from the results
            const allKeys = new Set();
            lastScrapingResults.forEach(result => {
                Object.keys(result).forEach(key => {
                    if (typeof result[key] !== 'object' || result[key] === null) {
                        allKeys.add(key);
                    }
                });
            });
            
            const headers = [...allKeys];
            
            // Generate CSV content
            let csvContent = headers.join(',') + '\n';
            
            lastScrapingResults.forEach(result => {
                const row = headers.map(header => {
                    const value = result[header];
                    
                    if (value === undefined || value === null) {
                        return '';
                    }
                    
                    if (typeof value === 'object') {
                        return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
                    }
                    
                    return `"${String(value).replace(/"/g, '""')}"`;
                });
                
                csvContent += row.join(',') + '\n';
            });
            
            await fs.promises.writeFile(filePath, csvContent, 'utf8');
        }
        
        event.sender.send('scraping-progress', {
            message: `Results exported successfully to ${filePath}`,
            level: 'INFO'
        });
    } catch (error) {
        console.error('Error exporting results:', error);
        event.sender.send('scraping-error', {
            message: `Failed to export results: ${error.message}`
        });
    }
});

// Clear results
ipcMain.on('clear-results', () => {
    lastScrapingResults = [];
});

// Add these event handlers to your main.js file

// Content extraction IPC handlers
ipcMain.on('content-extraction-start', (event) => {
    console.log('Content extraction started');
    // You could initialize any main process content extraction here if needed
});

ipcMain.on('content-extraction-complete', (event) => {
    console.log('Content extraction completed');
    // Any cleanup needed in the main process
});

ipcMain.on('stop-content-extraction', (event) => {
    console.log('Content extraction stopped');
    // Any cleanup needed in the main process
});

ipcMain.on('export-extraction-results', (event, format) => {
    console.log(`Exporting extraction results as ${format}`);
    
    // Ask user for save location
    dialog.showSaveDialog({
        title: 'Save Extraction Results',
        defaultPath: `extraction-results.${format}`,
        filters: format === 'csv' 
            ? [{ name: 'CSV Files', extensions: ['csv'] }]
            : [{ name: 'JSON Files', extensions: ['json'] }]
    }).then(result => {
        if (!result.canceled && result.filePath) {
            // Notify renderer to provide the data
            event.reply('export-extraction-path-selected', { 
                format: format, 
                path: result.filePath 
            });
        }
    }).catch(err => {
        console.error('Error showing save dialog:', err);
    });
});

// Add this to your main.js file
ipcMain.on('save-extraction-results', (event, data) => {
    const { results, format, path } = data;
    
    try {
        if (format === 'json') {
            fs.writeFileSync(path, JSON.stringify(results, null, 2), 'utf8');
        } else if (format === 'csv') {
            // Simple CSV conversion
            const headers = ['value', 'type', 'relatedInfo', 'url'];
            const csvRows = [headers.join(',')];
            
            results.forEach(result => {
                const values = headers.map(header => {
                    const value = result[header] || '';
                    // Escape commas and quotes in CSV
                    return `"${value.toString().replace(/"/g, '""')}"`;
                });
                csvRows.push(values.join(','));
            });
            
            fs.writeFileSync(path, csvRows.join('\n'), 'utf8');
        }
        
        event.reply('extraction-export-complete', {
            success: true,
            path: path
        });
    } catch (error) {
        console.error('Error saving extraction results:', error);
        event.reply('extraction-export-complete', {
            success: false,
            error: error.message
        });
    }
});

// Add this function to handle content extraction completion

// Handle content extraction completion notification from renderer
ipcMain.on('notify-content-extraction-complete', (event, data) => {
    console.log('Content extraction completed:', data);
    
    // Any cleanup or processing needed in the main process
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
        win.webContents.send('content-extraction-complete', {
            itemCount: data.itemCount || 0,
            timeTaken: data.timeTaken || '0.00',
            success: data.success || true
        });
    }
});

