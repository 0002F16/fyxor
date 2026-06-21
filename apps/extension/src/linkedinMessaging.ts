export async function sendLinkedInMessage<T>(tabId: number, message: { type: string }): Promise<T | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, message) as T;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-loader.js"] });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        return await chrome.tabs.sendMessage(tabId, message) as T;
      } catch {
        // Wait for the LinkedIn module to finish loading.
      }
    }
    return null;
  }
}
