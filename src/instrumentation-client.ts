import posthog from 'posthog-js'

// Initialize PostHog if the environment variables are set
if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
        defaults: '2026-05-30',
        // Privacy: the uploaded usage report is rendered in the DOM (usernames,
        // costs, models, cost centers, filename). Autocapture records the text of
        // clicked elements, which could leak that data, so it is disabled. Only
        // explicit, vetted events (see docs/analytics.md) and pageviews are sent.
        autocapture: false,
        disable_session_recording: true, // Never record the screen / DOM.
    })
}