import figlet from 'figlet';
import standardFont from 'figlet/importable-fonts/Standard.js';
import slantFont from 'figlet/importable-fonts/Slant.js';

/**
 * Generates ASCII art for the given text.
 * @param {string} text - The text to convert to ASCII art.
 * @returns {Promise<string>} - The generated ASCII art wrapped in markdown code blocks.
 */
export const fetchASCII = async (text) => {
    return new Promise((resolve) => {
        // Use Slant font if possible, or Standard
        figlet.parseFont('Slant', slantFont);
        figlet.text(text, { font: 'Slant' }, (err, data) => {
            if (err || !data) {
                // Fallback to Standard
                figlet.parseFont('Standard', standardFont);
                figlet.text(text, { font: 'Standard' }, (err2, data2) => {
                    resolve(data2 ? `\`\`\`\n${data2}\n\`\`\`` : `[ASCII Failed]`);
                });
            } else {
                resolve(`\`\`\`\n${data}\n\`\`\``);
            }
        });
    });
};
