const sendResult = (type, data, error = null) => {
  try {
    const message = {
      type: type,
      error: error,
      url: window.location.href,
      timestamp: Date.now(),
    };

    if (type === "SUBMISSION_CODE") {
      message.code = data;
    } else if (type === "PROBLEM_STATEMENT") {
      message.html = data;
    } else {
      message.data = data;
    }

    chrome.runtime.sendMessage(message);
  } catch (err) {
    console.warn(`Failed to send ${type} result:`, err);
  }
};

const extractSubmissionCode = () => {
  const selectors = [
    "pre#program-source-text",
    "pre.prettyprint",
    ".source pre",
    "#program-source-text",
    ".datatable pre",
  ];

  for (const selector of selectors) {
    try {
      const element = document.querySelector(selector);
      if (element) {
        // innerText is better than textContent as it respects line breaks and
        // often ignores elements styled with user-select: none (like line numbers)
        const code = element.innerText || element.textContent;
        if (code && code.trim().length > 0) {
          console.log(`✅ Found code using selector: ${selector}`);
          return code.trim();
        }
      }
    } catch (err) {
      console.warn(`Selector failed: ${selector}`, err);
    }
  }

  // Fallback: search for any pre that looks like code
  const allPre = document.querySelectorAll("pre");
  for (const pre of allPre) {
    const content = pre.innerText || pre.textContent;
    const trimmed = content.trim();
    if (
      trimmed.length > 50 &&
      (trimmed.includes("#include") ||
        trimmed.includes("import ") ||
        trimmed.includes("def ") ||
        trimmed.includes("public class") ||
        trimmed.includes("int main"))
    ) {
      console.log("✅ Found code using fallback pre search");
      return trimmed;
    }
  }

  return null;
};

const extractProblemStatement = () => {
  const selectors = [
    ".problem-statement",
    ".problemtext",
    ".problem",
    "#problem-statement",
    ".statement",
    'div[class*="problem"]',
  ];

  for (const selector of selectors) {
    try {
      const element = document.querySelector(selector);
      if (element && element.innerHTML.trim()) {
        console.log(`✅ Found problem statement using selector: ${selector}`);
        return element.innerHTML.trim();
      }
    } catch (err) {
      console.warn(`Problem selector failed: ${selector}`, err);
    }
  }

  try {
    const mainContent = document.querySelector(".main-content, .content, main");
    if (mainContent && mainContent.innerHTML.trim()) {
      console.log("✅ Found problem statement using fallback main content");
      return mainContent.innerHTML.trim();
    }
  } catch (err) {
    console.warn("Main content fallback failed:", err);
  }

  return null;
};

const quickExtract = () => {
  if (window.location.pathname.includes("/submission/")) {
    const code = extractSubmissionCode();
    if (code) {
      sendResult("SUBMISSION_CODE", code);
      return true;
    }
  }

  if (window.location.pathname.includes("/problem/")) {
    const problemHTML = extractProblemStatement();
    if (problemHTML) {
      sendResult("PROBLEM_STATEMENT", problemHTML);
      return true;
    }
  }

  return false;
};

const attemptExtraction = () => {
  if (quickExtract()) return;

  const errorIndicators = [
    ".access-denied",
    '[class*="error"]',
    '[class*="forbidden"]',
    '[class*="denied"]',
  ];

  for (const indicator of errorIndicators) {
    if (document.querySelector(indicator)) {
      const errorMsg =
        "Access denied - you may not have permission to view this page";

      if (window.location.pathname.includes("/submission/")) {
        sendResult("SUBMISSION_CODE", null, errorMsg);
      } else if (window.location.pathname.includes("/problem/")) {
        sendResult("PROBLEM_STATEMENT", null, errorMsg);
      }
      return;
    }
  }

  if (document.body.innerText.toLowerCase().includes("access denied")) {
    const errorMsg =
      "Access denied - you may not have permission to view this page";

    if (window.location.pathname.includes("/submission/")) {
      sendResult("SUBMISSION_CODE", null, errorMsg);
    } else if (window.location.pathname.includes("/problem/")) {
      sendResult("PROBLEM_STATEMENT", null, errorMsg);
    }
    return;
  }

  let attempts = 0;
  const maxAttempts = 20; // Try for up to 5 seconds (20 * 250ms)

  const tryExtract = () => {
    if (quickExtract()) return;

    attempts++;
    if (attempts >= maxAttempts) {
      if (window.location.pathname.includes("/submission/")) {
        sendResult("SUBMISSION_CODE", null, "Code element not found on page");
      } else if (window.location.pathname.includes("/problem/")) {
        sendResult(
          "PROBLEM_STATEMENT",
          null,
          "Problem statement not found on page"
        );
      }
    } else {
      setTimeout(tryExtract, 250);
    }
  };

  setTimeout(tryExtract, 250);
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  try {
    if (request.action === "extractSubmissionCode") {
      console.log("📨 Received request to extract submission code");

      const code = extractSubmissionCode();
      const response = {
        success: !!code,
        data: code,
        error: code ? null : "Code not found",
        url: window.location.href,
      };

      sendResponse(response);
      return true;
    }

    if (request.action === "extractProblemStatement") {
      console.log("📨 Received request to extract problem statement");

      const problemHTML = extractProblemStatement();
      const response = {
        success: !!problemHTML,
        data: problemHTML,
        error: problemHTML ? null : "Problem statement not found",
        url: window.location.href,
      };

      sendResponse(response);
      return true;
    }
  } catch (error) {
    console.error("❌ Error in message listener:", error);
    sendResponse({
      success: false,
      data: null,
      error: error.message,
      url: window.location.href,
    });
  }

  return false;
});

const initialize = () => {
  const isSubmissionPage = window.location.pathname.includes("/submission/");
  const isProblemPage = window.location.pathname.includes("/problem/");
  const isMySubmissions = window.location.pathname.includes("/submissions/");

  if (!isSubmissionPage && !isProblemPage && !isMySubmissions) {
    return;
  }

  console.log("🚀 CFPusher content script initialized", {
    url: window.location.href,
    isSubmissionPage,
    isProblemPage,
    isMySubmissions,
    readyState: document.readyState,
  });

  if (isSubmissionPage || isMySubmissions) {
    console.log("⚡ Triggering immediate sync due to submission page visit");
    chrome.runtime
      .sendMessage({ action: "triggerImmediateSync" })
      .catch(() => {});
  }

  attemptExtraction();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}

let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    console.log("🔄 URL changed, re-initializing...");
    setTimeout(initialize, 100);
  }
});

if (window.location.hostname.includes("codeforces.com")) {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

window.addEventListener("beforeunload", () => {
  observer.disconnect();
});
