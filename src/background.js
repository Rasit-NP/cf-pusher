/* eslint-disable no-undef */
import { fetchAcceptedSubmissions } from "./handlers/codeforcesHandler";
import {
  getSubmissionCode,
  getProblemStatement,
} from "./handlers/getSubmissionCode";
import { pushToGitHubWithRetry } from "./handlers/githubHandler";

let isSyncing = false;
let lastSyncTime = 0;

// 🚀 PERFORMANCE IMPROVEMENT: Ultra-fast sync for instant response
const SYNC_INTERVAL_MINUTES = 0.1; // 6 seconds for ultra-fast response
const MIN_SYNC_INTERVAL_MS = 2000; // Minimum 2 seconds between syncs for maximum responsiveness
// 🚀 Catch-up: how many unsynced submissions to push per sync run. Keeps each run
// bounded so a contest's worth of solves is backfilled over a few runs without
// blowing the GitHub rate limit (60 req/min; each submission costs ~4 requests).
const MAX_PUSHES_PER_SYNC = 5;

const langMapping = {
  "C++": "cpp",
  C: "c",
  Python: "py",
  Java: "java",
  JavaScript: "js",
  Ruby: "rb",
  Rust: "rs",
};

const getExtensionFromLanguage = (language) => {
  for (const key in langMapping) {
    if (language.indexOf(key) !== -1) {
      return langMapping[key];
    }
  }
  return "txt";
};

// 🚀 IMPROVEMENT: Add rate limiting protection
const rateLimitTracker = {
  codeforcesRequests: [],
  githubRequests: [],

  canMakeRequest(type) {
    const now = Date.now();
    const requests =
      type === "codeforces" ? this.codeforcesRequests : this.githubRequests;
    const limit = type === "codeforces" ? 5 : 60; // CF: 5 per minute, GitHub: 60 per minute

    // Remove requests older than 1 minute
    while (requests.length > 0 && now - requests[0] > 60000) {
      requests.shift();
    }

    return requests.length < limit;
  },

  recordRequest(type) {
    const requests =
      type === "codeforces" ? this.codeforcesRequests : this.githubRequests;
    requests.push(Date.now());
  },
};

// 🚀 IMPROVEMENT: Enhanced caching with TTL - optimized for ultra-fast sync
const cache = {
  submissions: { data: null, timestamp: 0, ttl: 30000 }, // 30 seconds TTL for ultra-fast updates
  problems: new Map(), // Map for problem statements with individual TTL

  get(key) {
    if (key === "submissions") {
      const now = Date.now();
      if (
        this.submissions.data &&
        now - this.submissions.timestamp < this.submissions.ttl
      ) {
        return this.submissions.data;
      }
      return null;
    }

    const problem = this.problems.get(key);
    if (problem && Date.now() - problem.timestamp < 900000) {
      // 15 minutes TTL for problems (ultra-fast updates)
      return problem.data;
    }
    return null;
  },

  set(key, value) {
    if (key === "submissions") {
      this.submissions = { data: value, timestamp: Date.now(), ttl: 30000 }; // 30 seconds TTL
    } else {
      this.problems.set(key, { data: value, timestamp: Date.now() });
    }
  },
};

// 🚀 IMPROVEMENT: Optimized problem statement fetching with better caching
const getProblemStatementCached = async (contestId, index, cacheKey) => {
  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`📋 Using cached problem statement for ${contestId}-${index}`);
    return cached;
  }

  try {
    console.log(`🌐 Fetching problem statement for ${contestId}-${index}`);
    const problemMarkdown = await getProblemStatement(contestId, index);

    if (problemMarkdown) {
      cache.set(cacheKey, problemMarkdown);
      console.log(`✅ Cached problem statement for ${contestId}-${index}`);
    }

    return problemMarkdown;
  } catch (error) {
    console.warn(`⚠️ Failed to fetch problem statement: ${error.message}`);
    return null;
  }
};

// NOTE: HTML -> Markdown conversion (including MathJax handling) now happens in
// the content script (src/content.js), which runs in a real page context with a
// DOM and rendered MathJax. The service worker has no DOMParser/document, so
// Turndown cannot run here — the problem statement arrives already as Markdown.

// 🚀 Push a single accepted submission (README + code) to GitHub.
// Returns true only when BOTH files are pushed, so the caller can mark it synced.
const processSubmission = async (submission, githubToken, linkedRepo) => {
  const {
    contestId,
    id: submissionId,
    index,
    problemName,
    programmingLanguage,
  } = submission;

  const folderName = `${contestId}/${index} - ${problemName}`;
  const extension = getExtensionFromLanguage(programmingLanguage);
  const filePath = `Codeforces/${folderName}/solution.${extension}`;
  const readmePath = `Codeforces/${folderName}/README.md`;
  const problemCacheKey = `cf-problem-${contestId}-${index}`;

  console.log(`⚡ Starting parallel fetch operations for ${folderName}...`);

  // 🚀 OPTIMIZATION: Run code and problem fetching in parallel
  const [codeResult, problemResult] = await Promise.allSettled([
    getSubmissionCode(contestId, submissionId),
    getProblemStatementCached(contestId, index, problemCacheKey),
  ]);

  // Handle code result
  if (codeResult.status === "rejected" || !codeResult.value) {
    const errorMsg = codeResult.reason?.message || "Unknown error";
    console.error("❌ Failed to get submission code:", errorMsg);

    // Check if it's an access issue
    if (errorMsg.includes("access denied") || errorMsg.includes("permission")) {
      console.log("🔒 Submission may be private or restricted");
    } else if (errorMsg.includes("Timeout")) {
      console.log("⏱️ Request timed out - page may be slow or inaccessible");
    }
    return false;
  }
  const code = codeResult.value;

  // Handle problem result (non-blocking). Already Markdown from the content script.
  let problemMarkdown = null;
  if (problemResult.status === "fulfilled" && problemResult.value) {
    problemMarkdown = problemResult.value;
  } else {
    const errorMsg = problemResult.reason?.message || "Unknown error";
    console.warn("⚠️ Could not retrieve problem statement:", errorMsg);

    // Check if it's an access issue
    if (errorMsg.includes("access denied") || errorMsg.includes("permission")) {
      console.log("🔒 Problem may be from a private contest or restricted");
    } else if (errorMsg.includes("Timeout")) {
      console.log("⏱️ Problem statement request timed out");
    }
  }

  console.log("⚡ Processing content...");
  const problemUrl = `https://codeforces.com/contest/${contestId}/problem/${index}`;

  // Problem statement is already converted to Markdown in the content script.
  const markdownContent = problemMarkdown;
  const readmeContent = markdownContent
    ? `# [${problemName}](${problemUrl})\n\n${markdownContent}`
    : `# [${problemName}](${problemUrl})\n\nProblem statement could not be retrieved. Please visit the link above.`;

  const commitMessage = `Add ${problemName} [${index}] from Codeforces`;

  console.log("⚡ Starting GitHub push operations...");

  let codePushSuccess = false;
  let readmePushSuccess = false;

  try {
    // Step 1: Push README first (creates the folder structure)
    console.log("📝 Pushing README first...");
    rateLimitTracker.recordRequest("github");
    readmePushSuccess = await pushToGitHubWithRetry({
      repoFullName: linkedRepo,
      githubToken,
      filePath: readmePath,
      commitMessage: `${commitMessage} (Problem Statement)`,
      content: readmeContent,
    });

    if (readmePushSuccess) {
      console.log("✅ README pushed successfully");

      // Small delay to ensure GitHub processes the folder creation
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 2: Push code after README succeeds (folder now exists)
      console.log("💻 Pushing code...");
      rateLimitTracker.recordRequest("github");
      codePushSuccess = await pushToGitHubWithRetry({
        repoFullName: linkedRepo,
        githubToken,
        filePath,
        commitMessage,
        content: code,
      });

      if (codePushSuccess) {
        console.log("✅ Code pushed successfully");
      } else {
        console.error("❌ Code push failed after retries");
      }
    } else {
      console.error("❌ README push failed, skipping code push");
    }
  } catch (error) {
    console.error("❌ Error during GitHub push operations:", error);
  }

  if (codePushSuccess && readmePushSuccess) {
    console.log(`✅ Successfully pushed ${folderName}`);
    return true;
  }

  console.error(`❌ Failed to push one or more files to ${folderName}`);
  if (!codePushSuccess) console.error("Code push failed");
  if (!readmePushSuccess) console.error("README push failed");
  return false;
};

// 🚀 IMPROVEMENT: Optimized sync function with better error handling and performance.
// Backfills EVERY accepted submission that hasn't been synced yet (oldest first),
// so a whole contest's solves get pushed, not just the most recent one. Bounded by
// MAX_PUSHES_PER_SYNC per run to respect rate limits; remaining ones catch up on
// the next sync.
const syncLatestAcceptedSubmission = async (
  githubToken,
  linkedRepo,
  username
) => {
  if (!githubToken || !linkedRepo || !username || isSyncing) return;

  // 🚀 Rate limiting check
  if (!rateLimitTracker.canMakeRequest("codeforces")) {
    console.warn("⏳ Rate limit reached for Codeforces API, skipping sync");
    return;
  }

  // 🚀 Minimum time between syncs
  const now = Date.now();
  if (now - lastSyncTime < MIN_SYNC_INTERVAL_MS) {
    console.log("⏳ Too soon since last sync, skipping");
    return;
  }

  isSyncing = true;
  lastSyncTime = now;
  console.log("🔁 Syncing accepted submissions...");
  const startTime = Date.now();

  try {
    // 🚀 Try cache first
    let accepted = cache.get("submissions");

    if (!accepted) {
      console.log("🌐 Fetching submissions from API");
      rateLimitTracker.recordRequest("codeforces");
      accepted = await fetchAcceptedSubmissions(username, 100); // Fetch more submissions for comprehensive sync
      cache.set("submissions", accepted);
    } else {
      console.log("📋 Using cached submissions");
    }

    if (accepted.length === 0) {
      console.log("📭 No accepted submissions found");
      return;
    }

    const cacheKey = `cf-synced-problems`;
    const result = await chrome.storage.sync.get([cacheKey]);
    let syncedProblems = result[cacheKey] || {};

    // 🚀 Backfill: process oldest unsynced first so READMEs/folders appear in
    // chronological order. The API returns newest-first, so reverse the filter.
    const pending = accepted
      .filter((s) => !syncedProblems[s.id])
      .reverse();

    if (pending.length === 0) {
      console.log("✅ All accepted submissions already synced");
      return;
    }

    console.log(
      `📥 ${pending.length} unsynced submission(s); pushing up to ${MAX_PUSHES_PER_SYNC} this run`
    );

    let pushedCount = 0;
    for (const submission of pending) {
      if (pushedCount >= MAX_PUSHES_PER_SYNC) {
        console.log("⏸️ Reached per-sync push limit, remaining will catch up next run");
        break;
      }

      // 🚀 Rate limiting check for GitHub before each submission (~4 requests each)
      if (!rateLimitTracker.canMakeRequest("github")) {
        console.warn("⏳ Rate limit reached for GitHub API, deferring remaining pushes");
        break;
      }

      const success = await processSubmission(submission, githubToken, linkedRepo);
      if (success) {
        syncedProblems[submission.id] = true;
        await chrome.storage.sync.set({ [cacheKey]: syncedProblems });
        pushedCount++;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Synced ${pushedCount} submission(s) in ${elapsed}s`);
  } catch (err) {
    console.warn("🚨 Error pushing accepted submissions:", err);
  } finally {
    isSyncing = false;
  }
};

// 🚀 IMPROVEMENT: Optimized periodic sync setup
const setupPeriodicSync = async () => {
  console.log("🔄 Setting up optimized periodic sync...");

  try {
    const [githubTokenObj, linkedRepoObj, cfHandleObj] = await Promise.all([
      new Promise((resolve) => chrome.storage.local.get("githubToken", resolve)),
      new Promise((resolve) => chrome.storage.sync.get("linkedRepo", resolve)),
      new Promise((resolve) => chrome.storage.sync.get("cf_handle", resolve)),
    ]);

    const githubToken = githubTokenObj.githubToken;
    const linkedRepo = linkedRepoObj.linkedRepo;
    const username = cfHandleObj.cf_handle;

    if (githubToken && linkedRepo && username) {
      // Clear existing alarms
      await chrome.alarms.clear("cfPusherSync");

      // Perform immediate sync
      await syncLatestAcceptedSubmission(githubToken, linkedRepo, username);

      // 🚀 Set up optimized periodic alarm (every 1 minute instead of 10 seconds)
      await chrome.alarms.create("cfPusherSync", {
        delayInMinutes: SYNC_INTERVAL_MINUTES,
        periodInMinutes: SYNC_INTERVAL_MINUTES,
      });

      console.log(
        `✅ Ultra-fast sync alarm created - will trigger every ${
          SYNC_INTERVAL_MINUTES * 60
        } seconds for instant response`
      );
    } else {
      console.warn("⚠️ One or more credentials missing. Skipping sync.");
      // Clear alarm if credentials are missing
      await chrome.alarms.clear("cfPusherSync");
    }
  } catch (error) {
    console.error("❌ Error during background sync setup:", error);
  }
};

// 🚀 IMPROVEMENT: Better alarm handling with error recovery
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "cfPusherSync") {
    console.log("⏰ Periodic sync alarm triggered");

    try {
      const [githubTokenObj, linkedRepoObj, cfHandleObj] = await Promise.all([
        new Promise((resolve) =>
          chrome.storage.local.get("githubToken", resolve)
        ),
        new Promise((resolve) =>
          chrome.storage.sync.get("linkedRepo", resolve)
        ),
        new Promise((resolve) => chrome.storage.sync.get("cf_handle", resolve)),
      ]);

      const githubToken = githubTokenObj.githubToken;
      const linkedRepo = linkedRepoObj.linkedRepo;
      const username = cfHandleObj.cf_handle;

      if (githubToken && linkedRepo && username) {
        await syncLatestAcceptedSubmission(githubToken, linkedRepo, username);
      } else {
        console.warn("⚠️ Missing credentials during alarm, clearing alarm");
        await chrome.alarms.clear("cfPusherSync");
      }
    } catch (error) {
      console.error("❌ Error during alarm sync:", error);
    }
  }
});

// 🚀 IMPROVEMENT: Enhanced startup logic with immediate sync
chrome.runtime.onStartup.addListener(() => {
  console.log("🚀 Extension startup detected - triggering immediate sync");
  setupPeriodicSync();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("🎉 Extension installed/updated - triggering immediate sync");
  setupPeriodicSync();
});

// 🚀 IMPROVEMENT: Handle storage changes to restart sync when credentials change
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync") {
    const syncCredentialKeys = ["linkedRepo", "cf_handle"];
    const hasSyncChanges = syncCredentialKeys.some((key) => changes[key]);
    if (hasSyncChanges) {
      console.log("🔄 Credentials changed, restarting sync");
      setTimeout(setupPeriodicSync, 1000);
    }
  }
  if (namespace === "local") {
    if (changes["githubToken"]) {
      console.log("🔄 GitHub token changed, restarting sync");
      setTimeout(setupPeriodicSync, 1000);
    }
  }
});

// 🚀 IMPROVEMENT: Enhanced message handling for faster sync
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "manualSync") {
    console.log("🔄 Manual sync triggered from popup");

    Promise.all([
      new Promise((resolve) => chrome.storage.local.get("githubToken", resolve)),
      new Promise((resolve) => chrome.storage.sync.get(["linkedRepo", "cf_handle"], resolve)),
    ]).then(async ([localResult, syncResult]) => {
      const githubToken = localResult.githubToken;
      const { linkedRepo, cf_handle } = syncResult;

      if (githubToken && linkedRepo && cf_handle) {
        try {
          await syncLatestAcceptedSubmission(
            githubToken,
            linkedRepo,
            cf_handle
          );
          sendResponse({ success: true });
        } catch (error) {
          console.error("Manual sync failed:", error);
          sendResponse({ success: false, error: error.message });
        }
      } else {
        sendResponse({ success: false, error: "Missing credentials" });
      }
    });

    return true; // Indicates we will send a response asynchronously
  }

  // 🚀 NEW: Immediate sync trigger when user activity is detected on Codeforces
  if (request.action === "triggerImmediateSync") {
    console.log("⚡ Immediate sync triggered by user activity");

    Promise.all([
      new Promise((resolve) => chrome.storage.local.get("githubToken", resolve)),
      new Promise((resolve) => chrome.storage.sync.get(["linkedRepo", "cf_handle"], resolve)),
    ]).then(async ([localResult, syncResult]) => {
      const githubToken = localResult.githubToken;
      const { linkedRepo, cf_handle } = syncResult;

      if (githubToken && linkedRepo && cf_handle) {
        // Clear cache to force fresh data
        cache.submissions.data = null;
        await syncLatestAcceptedSubmission(
          githubToken,
          linkedRepo,
          cf_handle
        );
      }
    });
  }
});
