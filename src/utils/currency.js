import { config } from './config';

export const fetchCurrency = async (from, to, amount = 1) => {
    // Timeout Promise
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
        const API_KEY = config.getApiKey('VITE_CURRENCY_API_KEY');
        if (!API_KEY) return null;

        // Default to USD if not specified
        from = from ? from.toUpperCase() : 'USD';
        to = to ? to.toUpperCase() : 'INR';

        const baseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
        const url = `${baseUrl}/currency/live?access_key=${API_KEY}&currencies=${from},${to}&source=USD&format=1`;

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) return null;

        const data = await response.json();
        if (!data.success || !data.quotes) return null;

        // Logic from CurrencyControl
        const usdToFrom = from === 'USD' ? 1 : data.quotes[`USD${from}`];
        const usdToTo = to === 'USD' ? 1 : data.quotes[`USD${to}`];

        if (!usdToFrom || !usdToTo) return null;

        const rate = (1 / usdToFrom) * usdToTo;
        const result = amount * rate;

        return `[Currency Converter: ${amount} ${from} = ${result?.toFixed(2) || 'N/A'} ${to} (Rate: 1 ${from} = ${rate?.toFixed(4) || 'N/A'} ${to})]`;

    } catch (e) {
        clearTimeout(timeoutId);
        console.error("Currency Fetch Error:", e);
        return null;
    }
};
