const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function generatePDF() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        
        // Load the HTML file
        const htmlPath = path.join(__dirname, 'templates', 'landing-page.html');
        const htmlContent = fs.readFileSync(htmlPath, 'utf8');
        
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        
        // Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '15mm',
                right: '15mm',
                bottom: '15mm',
                left: '15mm'
            },
            displayHeaderFooter: true,
            headerTemplate: '<div style="font-family: system-ui, sans-serif; font-size: 10pt; width: 100%; text-align: center; padding: 5px;">GlobalConnect - Complete Business Plan | Nexconn Build Challenge 2026</div>',
            footerTemplate: '<div style="font-family: system-ui, sans-serif; font-size: 10pt; width: 100%; text-align: center; padding: 5px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'
        });
        
        // Write PDF to file
        const outputPath = path.join(__dirname, 'GlobalConnect-Complete-Business-Plan.pdf');
        fs.writeFileSync(outputPath, pdfBuffer);
        
        console.log('✅ PDF generated successfully!');
        console.log(`📄 Output: ${outputPath}`);
        console.log(`📄 Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
        
    } catch (error) {
        console.error('Error generating PDF:', error);
        throw error;
    } finally {
        await browser.close();
    }
}

generatePDF().catch(console.error);
