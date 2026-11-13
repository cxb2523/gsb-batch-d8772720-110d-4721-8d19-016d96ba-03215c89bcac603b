export const createMessageTool = (onMessageDirect) => {
    return {
        name: 'message',
        description: 'AGENT TOOL: Send a direct message, notification, or result to the user. Use this when you are running asynchronously in the background and need to notify the user that your task is complete or if you need to report partial progress.',
        parameters: { content: 'string (The message to show the user)' },
        execute: async ({ content }) => {
            if (onMessageDirect) {
                // We wrap this in a timeout or direct call depending on how it's handled in App.jsx
                onMessageDirect(content);
                return `Successfully sent message to user.`;
            }
            return `Failed to send message: no UI callback attached.`;
        }
    };
};
