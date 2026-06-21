void import(chrome.runtime.getURL("assets/content.js")).catch((error) => {
  console.error("CV Tailor could not load on this LinkedIn page.", error);
});
