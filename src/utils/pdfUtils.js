import * as pdfjsLib from 'pdfjs-dist';

// Configure worker - local offline copy
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export const extractTextFromPDF = async (file) => {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        let fullText = "";

        const MAX_CHARS = 50000;

        // Iterate over all pages
        for (let i = 1; i <= pdf.numPages; i++) {
            if (fullText.length > MAX_CHARS) {
                fullText += `\n[...Truncated: PDF Content Limit Reached...]`;
                break;
            }

            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();

            // Extract text items and join them
            const pageText = textContent.items
                .map(item => item.str)
                .join(" ");

            fullText += `[Page ${i}]: ${pageText}\n\n`;
        }

        return fullText.trim();
    } catch (error) {
        console.error("Error extracting PDF text:", error);
        throw new Error("Failed to read PDF file.");
    }
};
