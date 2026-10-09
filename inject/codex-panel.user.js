(() => {
  "use strict";

  const VERSION = "0.6.13";
  const SOURCE_HASH = window.__CODEX_PANEL_SOURCE_HASH__;
  const SENTINEL_KEY = "__codexPanelInjection__";
  const DEFAULT_PANEL_URL = "http://127.0.0.1:47823/?host=codex";
  const ENTRY_ID = "codex-panel-entry";
  const PAGE_ID = "codex-panel-page";
  const FRAME_ID = "codex-panel-frame";
  const DRAG_REGION_ID = "codex-panel-drag-region";
  const NO_DRAG_LEFT_ID = "codex-panel-no-drag-left";
  const NO_DRAG_RIGHT_ID = "codex-panel-no-drag-right";
  const STATUS_ID = "codex-panel-status";
  const STYLE_ID = "codex-panel-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-panel-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-panel-native-hidden";
  const USAGE_BANNER_HIDDEN_ATTRIBUTE = "data-codex-panel-usage-banner-hidden";
  const HOST_ATTRIBUTE = "data-codex-panel-page-host";
  const NATIVE_ICON_ATTRIBUTE = "data-codex-panel-native-icon";
  const HOST_REQUEST_MESSAGE = "__codexPanelHostRequestV1";
  const HOST_RESPONSE_MESSAGE = "__codexPanelHostResponseV1";
  const HOST_HEARTBEAT_MESSAGE = "__codexPanelHostHeartbeatV1";
  const HOST_STARTUP_TOKEN_NAME = "__codexPanelHostStartupTokenV1";
  const HOST_CAPABILITY = window.__CODEX_PANEL_HOST_CAPABILITY__;
  const REATTACH_DELAY_MS = 160;
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const HOST_REQUEST_TIMEOUT_MS = 12_000;
  const COMPOSER_PREFILL_REQUEST_TIMEOUT_MS = 60_000;
  const TASK_CONVERSATION_REQUEST_TIMEOUT_MS = 75_000;
  const HOST_HEARTBEAT_MAX_AGE_MS = 8_000;
  const HOST_BINDING_READY_TIMEOUT_MS = 4_000;
  const THREAD_ASSOCIATION_TIMEOUT_MS = 10 * 60_000;
  const PENDING_THREAD_ASSOCIATION_KEY = "codex-panel.pending-thread-association.v1";
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const FRAME_REFRESH_PARAM = "__codex_panel_refresh";
  const PLUGIN_LABELS = ["插件", "外掛程式", "plugins", "プラグイン"];
  const EXPLORE_LABELS = ["探索", "explore"];
  // Default rail artwork from the native home, clock, library, images and skills icons.
  const NATIVE_OUTLINE_ICONS = {
    "builtin:home": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M9.16491 2.63173C9.71169 2.48215 10.289 2.48212 10.8358 2.63173C11.1778 2.72543 11.48 2.8889 11.7938 3.10145C12.1009 3.3095 12.4556 3.58934 12.8905 3.93251L17.079 7.23817L17.3319 7.43837V7.44032L18.329 8.22841C18.6169 8.45595 18.6666 8.87383 18.4393 9.162C18.2118 9.4502 17.793 9.49877 17.5048 9.27138L17.3319 9.13466V13.9999C17.3319 14.4554 17.3329 14.8371 17.3075 15.1483C17.2814 15.4673 17.2245 15.7709 17.078 16.0585C16.8546 16.4969 16.4978 16.8535 16.0594 17.077C15.772 17.2235 15.4682 17.2804 15.1493 17.3065C14.8382 17.3319 14.4562 17.3319 14.0008 17.3319H11.4188V13.9579C11.4186 13.175 10.7837 12.5404 10.0008 12.5399C9.21764 12.5399 8.58209 13.1747 8.5819 13.9579V17.3319H6.00084C5.54535 17.3319 5.16262 17.3319 4.85143 17.3065C4.53266 17.2805 4.22966 17.2234 3.94225 17.077C3.5036 16.8535 3.14627 16.4971 2.92272 16.0585C2.77621 15.7709 2.72027 15.4673 2.6942 15.1483C2.6688 14.8371 2.66881 14.4554 2.66881 13.9999V9.13466L2.49596 9.27138C2.20783 9.49885 1.79002 9.44991 1.56237 9.162C1.33486 8.87382 1.3837 8.45603 1.67174 8.22841L2.66881 7.44032V7.43837L2.92174 7.23817L7.1112 3.93251C7.54597 3.58945 7.89989 3.30942 8.2069 3.10145C8.52085 2.88883 8.82275 2.7254 9.16491 2.63173ZM9.99596 3.8495C9.91933 3.84967 9.84263 3.85439 9.76647 3.86415C9.68232 3.87496 9.59887 3.89241 9.51647 3.91493C9.42142 3.94095 9.31925 3.98378 9.19127 4.05556C9.12054 4.09534 9.04147 4.14337 8.95202 4.20399C8.69423 4.37873 8.38416 4.62336 7.93444 4.97841L3.99889 8.08485V13.9999C3.99889 14.4775 3.99942 14.7964 4.0194 15.0409C4.03875 15.2773 4.07319 15.3861 4.10827 15.455C4.20432 15.6432 4.35748 15.7965 4.54577 15.8925C4.61466 15.9275 4.72363 15.962 4.95983 15.9813C5.20432 16.0013 5.52348 16.0018 6.00084 16.0018H7.25182V13.9579C7.25201 12.4402 8.4831 11.2099 10.0008 11.2099C11.5182 11.2103 12.7487 12.4405 12.7489 13.9579V16.0018H14.0008C14.478 16.0018 14.7965 16.0013 15.0409 15.9813C15.277 15.962 15.3861 15.9275 15.4549 15.8925C15.6432 15.7964 15.7975 15.6433 15.8934 15.455C15.9285 15.3861 15.962 15.2772 15.9813 15.0409C16.0013 14.7964 16.0018 14.4775 16.0018 13.9999V8.08388L12.0673 4.97841C11.6172 4.6231 11.3066 4.37881 11.0487 4.20399C10.7979 4.034 10.6327 3.95536 10.4852 3.91493C10.3662 3.88233 10.2442 3.86252 10.1219 3.85438C10.08 3.8516 10.038 3.8494 9.99596 3.8495Z\" fill=\"currentColor\"/>",
    "builtin:automations": "<path d=\"M10 5.16895C10.3673 5.16895 10.665 5.46672 10.665 5.83398V9.82812C10.6649 10.1147 10.5513 10.3901 10.3486 10.5928L8.3877 12.5547C8.12804 12.814 7.70591 12.8141 7.44629 12.5547C7.18668 12.2951 7.18687 11.873 7.44629 11.6133L9.33496 9.72461V5.83398C9.33496 5.46685 9.63291 5.16916 10 5.16895Z\" fill=\"currentColor\"/> <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M10 1.83496C14.5094 1.83496 18.165 5.49059 18.165 10C18.165 14.5094 14.5094 18.165 10 18.165C5.49059 18.165 1.83496 14.5094 1.83496 10C1.83496 5.49059 5.49059 1.83496 10 1.83496ZM10 3.16504C6.22513 3.16504 3.16504 6.22513 3.16504 10C3.16504 13.7749 6.22513 16.835 10 16.835C13.7749 16.835 16.835 13.7749 16.835 10C16.835 6.22513 13.7749 3.16504 10 3.16504Z\" fill=\"currentColor\"/>",
    "builtin:library": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M14.1313 2.37447C15.3086 2.16719 16.4314 2.95315 16.6392 4.13033L18.4331 14.3071C18.6405 15.4844 17.8545 16.6071 16.6772 16.8149L15.2817 17.061C14.1043 17.2685 12.9815 16.4816 12.7739 15.3042L12.2905 12.5629V15.1665C12.2905 16.3619 11.3208 17.3311 10.1255 17.3315H8.7085C8.12542 17.3315 7.59678 17.0999 7.20752 16.7251C6.81832 17.0994 6.29107 17.3314 5.7085 17.3315H4.2915C3.09583 17.3315 2.12651 16.3621 2.12646 15.1665V4.83346C2.12646 3.63776 3.09581 2.66842 4.2915 2.66842H5.7085C6.29062 2.6685 6.8184 2.89905 7.20752 3.27291C7.5967 2.89857 8.12587 2.66842 8.7085 2.66842H10.1255C10.6837 2.66859 11.1908 2.8819 11.5747 3.22896C11.879 2.92154 12.2775 2.70138 12.7358 2.62056L14.1313 2.37447ZM4.2915 3.99849C3.83035 3.99849 3.45654 4.3723 3.45654 4.83346V15.1665C3.45659 15.6276 3.83037 16.0014 4.2915 16.0014H5.7085C6.16948 16.0012 6.54341 15.6275 6.54346 15.1665V4.83346C6.54346 4.37241 6.1695 3.99867 5.7085 3.99849H4.2915ZM8.7085 3.99849C8.24734 3.99849 7.87354 4.3723 7.87354 4.83346V15.1665C7.87358 15.6276 8.24736 16.0014 8.7085 16.0014H10.1255C10.5863 16.0011 10.9604 15.6274 10.9604 15.1665V4.97896C10.9502 4.88209 10.9432 4.78602 10.9458 4.69088C10.878 4.29801 10.5376 3.99883 10.1255 3.99849H8.7085ZM15.3296 4.36178C15.2495 3.90773 14.8159 3.60416 14.3618 3.68404L12.9663 3.93014C12.5919 3.99628 12.3196 4.30259 12.2808 4.66256C12.2852 4.71899 12.2905 4.77589 12.2905 4.83346V4.90279L14.0835 15.0737C14.1636 15.5278 14.5971 15.8315 15.0513 15.7514L16.4468 15.5053C16.9006 15.425 17.2036 14.9915 17.1235 14.5376L15.3296 4.36178Z\" fill=\"currentColor\"/>",
    "builtin:images": "<path d=\"M8.95794 8.50151C9.7853 8.50151 10.4567 9.17226 10.457 9.99956C10.457 10.8271 9.78545 11.4986 8.95794 11.4986C8.13064 11.4983 7.45989 10.8269 7.45989 9.99956C7.46013 9.17241 8.13079 8.50175 8.95794 8.50151Z\" fill=\"currentColor\"/> <path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M6.97356 3.95073C7.20937 2.27472 8.75937 1.1068 10.4355 1.34233L16.4101 2.18217C18.0862 2.41792 19.2541 3.96793 19.0185 5.64409L18.1786 11.6187C17.9429 13.2945 16.3936 14.4613 14.7177 14.2261L13.7802 14.0943L13.8095 14.3003C14.0449 15.9764 12.878 17.5265 11.2021 17.7623L5.22747 18.6011C3.55135 18.8367 2.00136 17.6697 1.76556 15.9937L0.925712 10.0191C0.690149 8.34297 1.85809 6.79299 3.53411 6.55717L6.6679 6.11577L6.97356 3.95073ZM6.45696 13.4781C5.86813 13.0344 5.02959 13.1519 4.58587 13.7408L3.07317 15.7476L3.08196 15.8082C3.21543 16.7568 4.09325 17.4179 5.04192 17.2847L10.4911 16.5181L6.45696 13.4781ZM9.69427 7.03471L3.71966 7.87358C2.77088 8.00692 2.10994 8.88478 2.24309 9.83354L2.81145 13.8843L3.52434 12.94C4.41016 11.765 6.08147 11.5301 7.25677 12.4156L11.9775 15.9732C12.3629 15.6007 12.5733 15.0575 12.4931 14.4859L11.6533 8.51128C11.5199 7.56254 10.643 6.90155 9.69427 7.03471ZM10.2509 2.65971C9.30204 2.52636 8.42434 3.18743 8.29095 4.13628L8.03899 5.92339L9.50872 5.71733C11.1849 5.4819 12.7351 6.65051 12.9706 8.32671L13.5878 12.7242L14.9023 12.9097C15.851 13.0429 16.7278 12.3818 16.8613 11.4332L17.7011 5.45854C17.8343 4.50986 17.1732 3.63205 16.2245 3.49858L10.2509 2.65971Z\" fill=\"currentColor\"/>",
    "builtin:skills": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M10.5208 1.88086C15.7221 1.88086 18.3078 5.71869 18.3079 9.1875C18.3079 10.6634 17.6928 12.1653 16.6019 13.0332C16.0469 13.4746 15.3655 13.7517 14.598 13.7559C13.9313 13.7594 13.2416 13.5557 12.5511 13.1377C11.9219 13.6395 11.2034 13.9685 10.4534 14.0312C9.535 14.108 8.63654 13.7825 7.91047 13.0283L7.87238 12.9883C7.85039 12.965 7.8186 12.9309 7.77863 12.8887C7.69832 12.8039 7.58559 12.6849 7.45637 12.5488C7.19751 12.2762 6.87183 11.9348 6.60578 11.6572L6.54719 11.5889C6.27521 11.2405 6.30519 10.736 6.6302 10.4229L6.84504 10.2158L6.10383 9.44629C5.84919 9.18175 5.857 8.76058 6.12141 8.50586C6.38599 8.25118 6.80713 8.2589 7.06184 8.52344L7.80305 9.29297L9.59406 7.56836L8.85383 6.7998C8.59913 6.5352 8.60778 6.11407 8.87238 5.85938C9.13699 5.60473 9.55813 5.61237 9.81281 5.87695L10.553 6.64648L10.7747 6.43359C11.1235 6.098 11.6792 6.10952 12.013 6.45996L13.3167 7.8291C14.0599 8.59431 14.3531 9.50484 14.2337 10.4219C14.1535 11.0377 13.8891 11.6205 13.5052 12.1455C13.9126 12.3481 14.2758 12.4274 14.5911 12.4258C15.0278 12.4233 15.4257 12.269 15.7737 11.9922C16.4894 11.4229 16.9779 10.3387 16.9779 9.1875C16.9777 6.36405 14.9015 3.21094 10.5208 3.21094C6.8614 3.21118 3.69922 6.00766 3.45344 9.52734C3.17857 13.4658 5.9647 16.7887 10.2064 16.7891C11.8181 16.7891 13.4105 16.3859 14.5159 15.5303C14.8063 15.3055 15.2247 15.3591 15.4495 15.6494C15.6741 15.9398 15.6207 16.3573 15.3304 16.582C13.9169 17.6762 12.0013 18.1191 10.2064 18.1191C5.1481 18.1188 1.80089 14.096 2.12629 9.43457C2.42465 5.16205 6.22034 1.8811 10.5208 1.88086ZM7.8802 11.0654C8.06588 11.2601 8.25662 11.4605 8.42023 11.6328C8.54982 11.7693 8.66289 11.8886 8.74348 11.9736C8.78365 12.016 8.81607 12.0508 8.8382 12.0742L8.87238 12.1094C9.33016 12.583 9.83897 12.7472 10.3431 12.7051C10.8683 12.661 11.4519 12.3855 11.9945 11.8633C12.543 11.3352 12.848 10.7668 12.9154 10.25C12.9794 9.75778 12.8385 9.24516 12.3587 8.75293L12.3538 8.74707L11.3665 7.70996L7.8802 11.0654Z\" fill=\"currentColor\"/>"
  };
  NATIVE_OUTLINE_ICONS["builtin:customize"] = NATIVE_OUTLINE_ICONS["builtin:skills"];
  const PROJECT_SECTION_LABELS = ["projects", "项目"];
  const TASK_SECTION_LABELS = ["tasks", "任务", "chats", "对话"];
  const SEND_LABELS = ["send", "发送", "傳送"];
  const NATIVE_WORKTREE_LABELS = ["新建本地工作树", "新增本機工作樹", "new local worktree"];
  const PANEL_ROUTE_STATE = "__codexPanel";

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && previous.hostCapability === HOST_CAPABILITY && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let page = null;
  let frame = null;
  let dragRegion = null;
  let noDragLeft = null;
  let noDragRight = null;
  let status = null;
  let frameOrigin = "";
  let panelOrigin = "";
  let framePanelUrl = "";
  let frameCapability = "";
  let frameChallenge = "";
  let frameReady = false;
  let frameReadyWaiters = new Set();
  let hostRequests = new Map();
  let hostRequestSequence = 0;
  let hostHeartbeatAt = 0;
  let observer = null;
  let reattachTimer = null;
  let hostContextTimer = null;
  let lastFocusedElement = null;
  let hostContextSnapshot = null;
  let codexProjectMetadata = new Map();
  let openGeneration = 0;
  let pendingThreadCreation = null;
  let pendingThreadAssociation = null;
  let nativeClaimPollInFlight = false;
  let lastNativeThreadId = "";
  let nativeNavigator = null;
  let detachNativeNavigation = null;
  let lastNativeLocation = null;
  const panelLocationKeys = new Set(previous?.sourceHash === SOURCE_HASH ? previous.panelLocationKeys : []);
  let pendingPanelNavigation = false;
  let lastNativeProjectId = "";
  let currentCodexUser = null;
  let suspendedNativeBrowserPanel = null;
  let active = false;
  let destroyed = false;
  let hideUsageBanner = false;

  function isExhaustedUsageBanner(banner) {
    const fiberKey = Object.keys(banner).find((key) => key.startsWith("__reactFiber$"));
    const propsKey = Object.keys(banner).find((key) => key.startsWith("__reactProps$"));
    let owner = banner[fiberKey];
    if (owner?.alternate && owner.alternate.memoizedProps === banner[propsKey]) owner = owner.alternate;
    // Read the owning banner's business type, not localized text or minified component names.
    for (let fiber = owner; fiber; fiber = fiber.return) {
      if (fiber.stateNode instanceof Element && fiber.stateNode !== banner) break;
      const type = fiber.memoizedProps?.banner?.banner_type;
      if (typeof type === "string") {
        return /^(?:pro|plus|prolite|free_trial|go_trial|free_or_go|business|cbp|legacy)_rate_limit_reached$/.test(type)
          || /^(?:workspace_member|workspace_owner)_(?:usage_limit_reached|credits_depleted)$/.test(type);
      }
    }
    return false;
  }

  function syncUsageBannerVisibility() {
    document.querySelectorAll("aside").forEach((banner) => {
      banner.toggleAttribute(USAGE_BANNER_HIDDEN_ATTRIBUTE, hideUsageBanner && isExhaustedUsageBanner(banner));
    });
  }

  function persistPendingThreadAssociation() {
    try {
      if (!pendingThreadAssociation) {
        window.localStorage.removeItem(PENDING_THREAD_ASSOCIATION_KEY);
        return;
      }
      window.localStorage.setItem(PENDING_THREAD_ASSOCIATION_KEY, JSON.stringify({
        taskId: pendingThreadAssociation.taskId,
        identifier: pendingThreadAssociation.identifier,
        existingThreadIds: [...pendingThreadAssociation.existingThreadIds],
        title: pendingThreadAssociation.title,
        projectId: pendingThreadAssociation.projectId,
        codexHostId: pendingThreadAssociation.codexHostId,
        workspacePath: pendingThreadAssociation.workspacePath,
        executionPreparation: pendingThreadAssociation.executionPreparation,
        planningPreparation: pendingThreadAssociation.planningPreparation,
        useWorktree: pendingThreadAssociation.useWorktree,
        threadId: pendingThreadAssociation.threadId,
        previousTurnId: pendingThreadAssociation.previousTurnId,
        developmentContext: pendingThreadAssociation.developmentContext,
        submitted: pendingThreadAssociation.submitted,
        expiresAt: pendingThreadAssociation.expiresAt,
      }));
    } catch {}
  }

  function setPendingThreadAssociation(value) {
    pendingThreadAssociation = value;
    persistPendingThreadAssociation();
  }

  function restorePendingThreadAssociation() {
    try {
      const stored = JSON.parse(window.localStorage.getItem(PENDING_THREAD_ASSOCIATION_KEY) || "null");
      if (
        typeof stored?.taskId !== "string"
        || typeof stored?.identifier !== "string"
        || !Array.isArray(stored?.existingThreadIds)
        || typeof stored?.expiresAt !== "number"
        || stored.expiresAt <= Date.now()
      ) {
        window.localStorage.removeItem(PENDING_THREAD_ASSOCIATION_KEY);
        return;
      }
      pendingThreadAssociation = {
        ...stored,
        title: typeof stored.title === "string" && stored.title.trim()
          ? stored.title.trim()
          : stored.identifier,
        composer: null,
        existingThreadIds: new Set(stored.existingThreadIds),
        confirming: false,
      };
    } catch {
      window.localStorage.removeItem(PENDING_THREAD_ASSOCIATION_KEY);
    }
  }

  restorePendingThreadAssociation();

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isInteractiveElement(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    if (
      style.display === "none"
      || style.visibility === "hidden"
      || style.visibility === "collapse"
      || style.pointerEvents === "none"
      || (Number.isFinite(opacity) && opacity <= 0)
    ) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  }

  function normalizeThreadId(value) {
    return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  }

  function resolvePanelUrl() {
    const configuredValue = typeof window.__CODEX_PANEL_URL__ === "string"
      ? window.__CODEX_PANEL_URL__
      : window.__CODEX_TASKBOARD_URL__;
    const configured = typeof configuredValue === "string" ? configuredValue.trim() : "";
    try {
      const url = new URL(configured || DEFAULT_PANEL_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported panel URL protocol");
      }
      if (!url.searchParams.has("host")) url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_PANEL_URL);
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      #${ENTRY_ID}:not([aria-current="page"]) {
        color: var(--button-text-color, var(--color-token-foreground, inherit));
      }
      #${ENTRY_ID}[data-codex-panel-rail="true"] {
        display: flex;
        align-items: center;
        justify-content: center;
        align-self: center;
        flex: none;
        width: var(--height-token-nav-row, 36px);
        height: var(--height-token-nav-row, 36px);
        padding: 0;
        margin-top: 8px;
        color: var(--color-text-tertiary, var(--color-token-text-secondary, #888));
        background: transparent;
        border-radius: var(--radius-token-row, 10px);
        -webkit-app-region: no-drag;
      }
      #${ENTRY_ID}[data-codex-panel-rail="true"][aria-current="page"] {
        color: var(--color-text-primary, var(--color-token-foreground, #222));
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      }
      #${ENTRY_ID}[data-codex-panel-rail="true"]:hover {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      }
      #${ENTRY_ID}[data-codex-panel-rail="true"] svg {
        width: 20px;
        height: 20px;
      }
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        pointer-events: none !important;
      }
      [${USAGE_BANNER_HIDDEN_ATTRIBUTE}] {
        display: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] nav[data-app-navigation-rail] {
        visibility: visible !important;
        pointer-events: auto !important;
      }
      /* Preserve the native titlebar's drag shell, not its task-specific content. */
      [${HOST_ATTRIBUTE}="true"] [data-app-shell-titlebar="true"] {
        visibility: visible !important;
      }
      [${HOST_ATTRIBUTE}="true"] [data-app-shell-main-titlebar="true"] {
        visibility: hidden !important;
      }
      :root[data-codex-panel-open="true"] nav[data-app-navigation-rail] button[data-selected]:not(#${ENTRY_ID}):not(:hover) {
        color: var(--button-text-color) !important;
      }
      :root[data-codex-panel-open="true"] nav[data-app-navigation-rail] button[data-selected]:not(#${ENTRY_ID}):not(:hover)::before {
        opacity: 0 !important;
      }
      #${ENTRY_ID} [data-panel-icon="filled"] {
        display: none;
      }
      #${ENTRY_ID}[data-selected] [data-panel-icon="outline"] {
        display: none;
      }
      #${ENTRY_ID}[data-selected] [data-panel-icon="filled"] {
        display: initial;
      }
      /* Keep React's SVG node and the native button's focus-ring pseudo-element. */
      :root[data-codex-panel-open="true"] button[data-selected][${NATIVE_ICON_ATTRIBUTE}] svg {
        background: currentColor;
        mask: var(--codex-panel-native-icon) center / contain no-repeat;
      }
      :root[data-codex-panel-open="true"] button[data-selected][${NATIVE_ICON_ATTRIBUTE}] svg > * {
        visibility: hidden;
      }
      #${PAGE_ID} {
        position: absolute;
        top: var(--app-shell-titlebar-height, 0px);
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 1;
        border-radius: var(--radius-xl-base, 0px);
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${FRAME_ID}[hidden] {
        display: none !important;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${NO_DRAG_LEFT_ID},
      #${NO_DRAG_RIGHT_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: no-drag;
      }
      #${DRAG_REGION_ID}[hidden],
      #${NO_DRAG_LEFT_ID}[hidden],
      #${NO_DRAG_RIGHT_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} button {
        margin-top: 10px;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 7px;
        padding: 5px 10px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const text = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(text);
  }

  function findReferenceButton() {
    // 新版可能保留多个侧边栏；跳过隐藏或 inert 的旧节点，不能只检查第一个。
    const available = (node) => !node.closest("[inert], [hidden]")
      && node.getBoundingClientRect().height > 0;
    const rail = Array.from(document.querySelectorAll("nav[data-app-navigation-rail]")).find(available);
    const explore = Array.from(rail?.querySelectorAll("button") || []).find((button) =>
      button.getAttribute(OWNED_ATTRIBUTE) !== "true" && buttonMatches(button.querySelector(".sr-only"), EXPLORE_LABELS));
    if (explore) return explore;
    const sidebar = Array.from(document.querySelectorAll("[data-slate-sidebar-content]"))
      .find(available);
    const destinations = Array.from(sidebar?.querySelectorAll("[data-sidebar-destination]") || [])
      .filter((node) => node.getAttribute(OWNED_ATTRIBUTE) !== "true"
        && available(node));
    if (destinations.length > 0) {
      return destinations.find((node) => buttonMatches(node, PLUGIN_LABELS)) || destinations.at(-1);
    }
    const scroll = Array.from((sidebar || document).querySelectorAll("[data-app-action-sidebar-scroll]"))
      .find(available);
    const buttons = Array.from(scroll?.querySelectorAll('button, a.sidebar-item, [role="button"].sidebar-item') || [])
      .filter((button) => button.getAttribute(OWNED_ATTRIBUTE) !== "true" && available(button));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin) return plugin;

    const firstSection = scroll?.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top;
    const reference = buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.height > 0
        && rect.bottom <= sectionTop;
    }).at(-1);
    if (reference) return reference;

    // Free 账号可能没有插件、宠物或 destination 行；仅在主侧边栏内借用新聊天入口。
    const root = sidebar || Array.from(document.querySelectorAll("aside")).find(available);
    return Array.from(root?.querySelectorAll('button, a, [role="button"]') || [])
      .find((node) => node.getAttribute(OWNED_ATTRIBUTE) !== "true"
        && available(node)
        && buttonMatches(node, ["新聊天", "新对话", "新增聊天", "新對話", "new chat", "new thread"])) || null;
  }

  function replaceEntryIcon(button) {
    const slot = button.querySelector(".icon-leading-slot");
    let icon = button.querySelector("svg");
    // 参考行可能使用宠物头像而非 SVG；清空整个图标槽，避免继承头像与动画。
    if (slot) {
      icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "icon-leading");
      slot.replaceChildren(icon);
    }
    // 无独立文字节点的参考行会被替换为纯文字，仍需补上自己的图标。
    if (!icon) {
      icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "icon-leading");
      icon.setAttribute("width", "20");
      icon.setAttribute("height", "20");
      button.prepend(icon);
    }
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `
      <g data-panel-icon="outline">
        <rect x="3.5" y="4" width="17" height="16" rx="2.5"></rect>
        <path d="M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5"></path>
      </g>
      <path data-panel-icon="filled" fill="currentColor" stroke="none" fill-rule="evenodd"
        d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm-1 3v12a1 1 0 0 0 1 1h2V5H6a1 1 0 0 0-1 1Zm8 1v2h5V7h-5Zm0 4v2h5v-2h-5Zm0 4v2h5v-2h-5Z"></path>
    `;
  }

  function createEntry(reference, rail = false) {
    // 图标栏使用独立按钮，不继承原生拖拽及导航状态。
    const button = rail ? document.createElement("button") : reference.cloneNode(true);
    if (rail) button.className = reference.className;
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-haspopup");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.removeAttribute("href");
    button.removeAttribute("aria-labelledby");
    button.removeAttribute("aria-current");
    for (const name of button.getAttributeNames()) {
      if (name.startsWith("data-app-action-") || name.startsWith("data-sidebar-") || name.startsWith("data-slate-sidebar-")) button.removeAttribute(name);
    }
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.setAttribute("aria-label", "打开任务面板");
    button.setAttribute("title", "任务面板");
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    button.querySelectorAll("span.absolute.end-0.top-0").forEach((node) => node.remove());
    const label = button.querySelector(".sr-only") || button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    if (label) {
      label.textContent = "任务面板";
      // 导航栏沿用本地图标容器；展开侧栏只保留图标和文字，去掉原生提示点。
      if (!reference.closest("nav[data-app-navigation-rail]")) {
        const icon = button.querySelector(".icon-leading-slot") || button.querySelector("svg");
        button.replaceChildren(...(icon ? [icon, label] : [label]));
      }
    } else button.textContent = "任务面板";
    replaceEntryIcon(button);
    if (rail) {
      button.setAttribute("data-codex-panel-rail", "true");
      button.replaceChildren(button.querySelector("svg"));
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel();
    });
    if (button.tagName !== "BUTTON") {
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        button.click();
      });
    }
    return button;
  }

  function syncEntryState() {
    if (!entry) return;
    if (entry.hasAttribute("data-selected") !== active) {
      entry.toggleAttribute("data-selected", active);
    }
    if (active && entry.getAttribute("aria-current") !== "page") {
      entry.setAttribute("aria-current", "page");
    } else if (!active && entry.hasAttribute("aria-current")) {
      entry.removeAttribute("aria-current");
    }
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    // 左侧图标栏独立于展开的内容侧边栏；挂在可滚动导航区末尾、头像区之前。
    const rail = Array.from(document.querySelectorAll("[data-app-navigation-rail]"))
      .find((node) => !node.closest("[inert], [hidden]") && node.getBoundingClientRect().height > 0);
    const railReference = Array.from(rail?.querySelectorAll("[data-sidebar-destination]") || [])
      .find((node) => node.getBoundingClientRect().height > 0);
    const railList = railReference?.closest(".overflow-y-auto");
    if (railList && rail.contains(railList)) {
      if (entry?.getAttribute("data-codex-panel-rail") !== "true") {
        entry?.remove();
        entry = createEntry(railReference, true);
      }
      if (entry.parentElement !== railList) railList.appendChild(entry);
      syncEntryState();
      return;
    }
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    // 没有图标栏的旧布局继续沿用原入口，不将图标样式带入文字导航。
    if (entry?.getAttribute("data-codex-panel-rail") === "true") {
      entry.remove();
      entry = null;
    }
    // 新聊天按钮可能只是横向行的一部分；在整行之后挂载，不能挤入快速聊天所在的行内。
    const row = reference.parentElement.closest(".sidebar-item") || reference;
    if (!entry) entry = createEntry(reference);
    entry.style.height = row !== reference ? "var(--nav-item-height, var(--height-token-row, 36px))" : "";
    entry.style.flex = row !== reference ? "none" : "";
    entry.style.width = row !== reference ? "100%" : "";
    if (reference.closest("nav[data-app-navigation-rail]")) {
      if (entry.parentElement !== reference.parentElement || entry.nextElementSibling !== reference) reference.before(entry);
    } else if (entry.parentElement !== row.parentElement || entry.previousElementSibling !== row) {
      row.after(entry);
    }
    syncEntryState();
  }

  function findPageHost() {
    // 新版 Codex 保留多个隐藏工作区；面板打开后原内容被隐藏，继续复用已挂载的区域。
    const viewport = Array.from(document.querySelectorAll("[data-app-shell-main-content-layout]"))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (rect.width > 0 && rect.height > 0)
          || (page?.isConnected && page.parentElement === candidate.parentElement);
      });
    if (!viewport) return null;
    const direct = viewport.querySelector(".app-shell-main-content-frame");
    if (direct) return direct;
    const viewportRect = viewport.getBoundingClientRect();
    return Array.from(viewport.children).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width >= viewportRect.width * 0.8
        && rect.height >= viewportRect.height * 0.7;
    }) || null;
  }

  function findPageMount() {
    const frameHost = findPageHost();
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]");
    const workspace = viewport?.closest("[data-app-shell-workspace-row]");
    const rail = workspace?.querySelector("nav[data-app-navigation-rail]");
    const surface = rail ? workspace : viewport?.parentElement;
    if (!frameHost || !viewport || !surface || (!rail && !surface.closest("main"))) return null;
    return { frameHost, surface, rail };
  }

  function syncNativeRailIcons() {
    document.querySelectorAll('nav[data-app-navigation-rail] [data-sidebar-destination]')
      .forEach((button) => {
        const body = NATIVE_OUTLINE_ICONS[button.getAttribute("data-sidebar-destination")];
        if (!body || button.hasAttribute(NATIVE_ICON_ATTRIBUTE)) return;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">${body}</svg>`;
        button.style.setProperty("--codex-panel-native-icon", `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
        button.setAttribute(NATIVE_ICON_ATTRIBUTE, "outline");
      });
  }

  function restoreNativeRailIcons() {
    document.querySelectorAll(`button[${NATIVE_ICON_ATTRIBUTE}]`).forEach((button) => {
      button.removeAttribute(NATIVE_ICON_ATTRIBUTE);
      button.style.removeProperty("--codex-panel-native-icon");
    });
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return window.getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function threadIdFromLocation() {
    // Native in-app navigation can leave the window URL unchanged.
    const activeId = normalizeThreadId(activeThreadRow()?.getAttribute("data-app-action-sidebar-thread-id"));
    if (activeId) return activeId;
    const source = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function activeThreadRow() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    return rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || null;
  }

  function requestNativeFetch(path, body) {
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const requestId = `panel-native-fetch-${crypto.randomUUID()}`;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "fetch-response"
          || message.requestId !== requestId
        ) return;
        if (!Number.isInteger(message.status) || message.status < 200 || message.status >= 300) {
          finish(undefined);
          return;
        }
        try {
          finish(JSON.parse(message.bodyJsonString || "null"));
        } catch (_) {
          finish(undefined);
        }
      };
      const timeout = window.setTimeout(() => finish(undefined), 1_000);
      window.addEventListener("message", onMessage);
      try {
        bridge.sendMessageFromView({
          type: "fetch",
          requestId,
          method: "POST",
          url: `vscode://codex/${path}`,
          body: JSON.stringify(body),
        });
      } catch (_) {
        finish(undefined);
      }
    });
  }

  async function selectedNativeProjectId() {
    const selectedProject = (await requestNativeFetch(
      "get-global-state",
      { key: "selected-project" },
    ))?.value;
    return typeof selectedProject?.projectId === "string" ? selectedProject.projectId : "";
  }

  async function readCodexProjectMetadata() {
    const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
    const entries = new Map(
      (Array.isArray(bootstrap?.globalStateEntries) ? bootstrap.globalStateEntries : [])
        .map((entry) => [entry?.key, entry?.value]),
    );
    const [currentLocalProjects, currentRemoteProjects] = await Promise.all([
      requestNativeFetch("get-global-state", { key: "local-projects" }),
      requestNativeFetch("get-global-state", { key: "remote-projects" }),
    ]);
    const metadata = new Map();
    const localProjects = currentLocalProjects === undefined
      ? entries.get("local-projects")
      : currentLocalProjects?.value;
    if (localProjects && typeof localProjects === "object" && !Array.isArray(localProjects)) {
      Object.entries(localProjects).forEach(([projectId, project]) => {
        const id = projectId.trim();
        const workspacePath = Array.isArray(project?.rootPaths)
          ? project.rootPaths.find((root) => typeof root === "string" && root.trim())?.trim()
          : "";
        if (!id) return;
        metadata.set(id, {
          projectKind: "local",
          hostId: "local",
          ...(workspacePath ? { workspacePath } : {}),
        });
      });
    }
    const remoteProjects = currentRemoteProjects === undefined
      ? entries.get("remote-projects")
      : currentRemoteProjects?.value;
    if (Array.isArray(remoteProjects)) {
      remoteProjects.forEach((project) => {
        const id = typeof project?.id === "string" ? project.id.trim() : "";
        const workspacePath = typeof project?.remotePath === "string"
          ? project.remotePath.trim()
          : "";
        const hostId = typeof project?.hostId === "string" ? project.hostId.trim() : "";
        if (!id || !workspacePath || !hostId) return;
        metadata.set(id, {
          projectKind: "remote",
          workspacePath,
          hostId,
          name: typeof project?.label === "string" && project.label.trim()
            ? project.label.trim()
            : id,
        });
      });
    }
    return metadata;
  }

  async function activeNativeWorkspaceRoots() {
    const response = await requestNativeFetch("active-workspace-roots", {});
    const roots = response?.roots;
    // Keep an unavailable endpoint distinct from a successful response with no
    // workspace roots. The latter must not be treated as a confirmed switch.
    return {
      available: Array.isArray(roots),
      roots: Array.isArray(roots) ? roots.filter((root) => typeof root === "string") : [],
    };
  }

  function normalizeNativeRootPath(value) {
    const path = String(value || "").trim();
    if (!path) return "";
    const windowsPath = /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\");
    const normalizedSlashes = windowsPath ? path.replace(/\\/g, "/") : path;
    const withoutTrailingSlash = normalizedSlashes.replace(/\/+$/, "")
      || (normalizedSlashes.startsWith("/") ? "/" : normalizedSlashes);
    if (!windowsPath || !/^[A-Za-z]:/.test(withoutTrailingSlash)) return withoutTrailingSlash;
    return `${withoutTrailingSlash[0].toLowerCase()}${withoutTrailingSlash.slice(1)}`;
  }

  async function canonicalNativeRootPaths(roots) {
    const normalizedRoots = roots.map((root) => normalizeNativeRootPath(root));
    const response = await requestNativeFetch("workspace-root-options", {
      hostId: "local",
      canonicalizeRoots: roots,
    });
    const canonicalPathByRoot = response?.canonicalPathByRoot;
    if (!canonicalPathByRoot || typeof canonicalPathByRoot !== "object") return normalizedRoots;
    const canonicalRoots = roots.map((root) => (
      typeof canonicalPathByRoot[root] === "string"
        ? normalizeNativeRootPath(canonicalPathByRoot[root])
        : ""
    ));
    return canonicalRoots.every(Boolean) ? canonicalRoots : normalizedRoots;
  }

  function readCodexProjects(metadata = codexProjectMetadata) {
    const seen = new Set();
    const projects = Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .flatMap((row) => {
        const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
        const name = (
          row.getAttribute("data-app-action-sidebar-project-label")
          || row.getAttribute("aria-label")
          || ""
        ).trim();
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name, ...metadata.get(id) }];
      });
    for (const [id, project] of metadata) {
      if (project.projectKind !== "remote" || seen.has(id)) continue;
      projects.push({ id, ...project });
    }
    return projects;
  }

  function findProjectsSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section-heading]"))
      .find((node) => PROJECT_SECTION_LABELS.includes(normalizedLabel(
        node.getAttribute("data-app-action-sidebar-section-heading") || node.textContent,
      )))
      ?.closest("[data-app-action-sidebar-section]") || null;
  }

  function findTasksSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section]"))
      .find((section) => {
        const heading = section.querySelector("[data-app-action-sidebar-section-heading]");
        const label = heading?.getAttribute("data-app-action-sidebar-section-heading")
          || heading?.textContent
          || section.textContent;
        return TASK_SECTION_LABELS.includes(normalizedLabel(label));
      }) || null;
  }

  async function captureHostContext() {
    const todoProgress = nativeTodoProgress();
    const [selectedProjectId, metadata, currentUser] = await Promise.all([
      selectedNativeProjectId(),
      readCodexProjectMetadata(),
      requestHost("read-current-user"),
    ]);
    const user = await readCodexUser(typeof currentUser?.userId === "string" ? currentUser.userId : "");
    codexProjectMetadata = metadata;
    if (selectedProjectId) lastNativeProjectId = selectedProjectId;
    let projects = readCodexProjects();
    let section = findProjectsSection();
    const sectionDeadline = Date.now() + 1_200;
    while (!section && Date.now() < sectionDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    const tasksSection = findTasksSection();
    const expandedSections = [section, tasksSection].filter((candidate) => (
      candidate?.getAttribute("data-app-action-sidebar-section-collapsed") === "true"
    ));
    expandedSections.forEach((candidate) => (
      candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click()
    ));
    if (expandedSections.length > 0) {
      const deadline = Date.now() + 1_200;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        projects = readCodexProjects();
      } while ((projects.length === 0 || !activeThreadRow()) && Date.now() < deadline);
    }
    const context = { ...readHostContext(projects, lastNativeProjectId), user };
    if (context.threadRunning && todoProgress) context.threadTodoProgress = todoProgress;
    expandedSections.forEach((candidate) => {
      if (candidate.isConnected && candidate.getAttribute("data-app-action-sidebar-section-collapsed") === "false") {
        candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
      }
    });
    return context;
  }

  function workspaceFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("workspace") || url.searchParams.get("cwd") || "";
    } catch (_) {
      return "";
    }
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const surfaceLeft = (findPageMount()?.rail?.getBoundingClientRect().right ?? findPageMount()?.surface.getBoundingClientRect().left);
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(
      document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'),
    );
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function sidebarThreadRow(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((candidate) => normalizeThreadId(
        candidate.getAttribute("data-app-action-sidebar-thread-id"),
      ) === normalizedThreadId) || null;
  }

  function nativeRunningThreadRow(preferredThreadId, preferredProjectId) {
    const rows = Array.from(document.querySelectorAll(".sidebar-item .animate-spin"))
      .map((spinner) => spinner.closest("[data-app-action-sidebar-thread-id]"))
      .filter(Boolean);
    const normalizedPreferredThreadId = normalizeThreadId(preferredThreadId);
    if (normalizedPreferredThreadId) {
      return rows.find((candidate) => normalizeThreadId(
        candidate.getAttribute("data-app-action-sidebar-thread-id"),
      ) === normalizedPreferredThreadId) || null;
    }
    if (preferredProjectId) {
      const projectRows = rows.filter((candidate) => (
        candidate.closest("[data-app-action-sidebar-project-list-id]")
          ?.getAttribute("data-app-action-sidebar-project-list-id") === preferredProjectId
      ));
      if (projectRows.length === 1) return projectRows[0];
    }
    return rows.length === 1 ? rows[0] : null;
  }

  function nativeThreadRunning(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    const threadRow = sidebarThreadRow(normalizedThreadId);
    if (threadRow?.querySelector(".animate-spin")) return true;
    const running = Array.from(document.querySelectorAll("button[aria-label]")).some((button) => {
      const label = normalizedLabel(button.getAttribute("aria-label"));
      return ["停止", "停止生成", "stop", "stop generating"].includes(label);
    });
    const activeThreadId = normalizeThreadId(
      activeThreadRow()?.getAttribute("data-app-action-sidebar-thread-id"),
    );
    if (running && (!normalizedThreadId || activeThreadId === normalizedThreadId)) return true;
    if (threadRow) return false;
    const composer = document.querySelector(
      "[contenteditable='true'][role='textbox'], textarea",
    );
    return composer ? false : undefined;
  }

  function nativeTodoProgress() {
    const indicator = Array.from(
      document.querySelectorAll('[data-in-progress-fixed-content="true"]'),
    ).at(-1);
    const label = Array.from(indicator?.querySelectorAll("span") ?? [])
      .map((element) => element.textContent?.trim() ?? "")
      .find((text) => /\d+\s*\/\s*\d+/.test(text));
    const match = label?.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;
    const current = Number(match[1]);
    const total = Number(match[2]);
    return {
      completed: Math.max(0, Math.min(total, current - 1)),
      total,
    };
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (!trigger || !nativeSidebarCollapsed()) return;
    trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function userIdFromName(name) {
    const slug = name.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96);
    if (slug) return slug;
    let hash = 2166136261;
    for (const character of name) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `codex-user-${(hash >>> 0).toString(36)}`;
  }

  function codexProfileMenu(profileButton) {
    const menuId = profileButton.getAttribute("aria-controls");
    const menu = menuId ? document.getElementById(menuId) : null;
    return menu?.getAttribute("role") === "menu"
      && menu.getAttribute("aria-labelledby") === profileButton.id
      ? menu
      : null;
  }

  function hostError(chinese, english) {
    const error = new Error(chinese);
    error.englishMessage = english;
    return error;
  }

  function readCodexProfileIdentity(profileButton) {
    const menu = codexProfileMenu(profileButton);
    for (const row of menu?.querySelectorAll('[role="menuitem"], [role="separator"]') ?? []) {
      if (row.getAttribute("role") === "separator") break;
      if (row.hasAttribute("aria-label")) continue;
      const content = row.querySelector("[data-menu-row-content]");
      // The name is separate from both the leading avatar and the optional plan.
      const name = content?.querySelector(
        ":scope > div.flex.min-w-0.flex-1.flex-col > span.min-w-0.truncate:first-child,"
        + ":scope > span.flex-1.min-w-0",
      )?.textContent?.replace(/\s+/g, " ").trim();
      if (!name) continue;
      const avatar = content.querySelector(":scope > span img") || profileButton.querySelector("img");
      return { name, avatarUrl: avatar?.currentSrc || avatar?.src || null };
    }
    return null;
  }

  async function normalizeCodexAvatar(avatarUrl) {
    if (!avatarUrl?.startsWith("data:")) return avatarUrl;
    const image = new Image();
    image.src = avatarUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    // Keep inline avatars within the existing 2048-character actor header budget.
    for (const size of [48, 32, 16]) {
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(
        image,
        (image.naturalWidth - sourceSize) / 2, (image.naturalHeight - sourceSize) / 2,
        sourceSize, sourceSize, 0, 0, size, size,
      );
      const result = canvas.toDataURL("image/webp", 0.8);
      if (result.startsWith("data:image/webp;base64,") && result.length <= 2048) return result;
    }
    throw hostError("无法将 Codex 头像缩小至身份请求头限制", "Could not fit the Codex avatar into the identity header");
  }

  async function readCodexUser(userId) {
    const profileButton = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => (
      normalizedLabel(button.getAttribute("aria-label")).includes("profile")
      || normalizedLabel(button.getAttribute("aria-label")).includes("个人资料")
    ));
    if (!profileButton) return null;
    // The compact rail already carries the identity in its profile component.
    // Opening its menu to read hidden text visibly opens Codex's settings menu.
    const fiberKey = Object.keys(profileButton).find((key) => key.startsWith("__reactFiber$"));
    const propsKey = Object.keys(profileButton).find((key) => key.startsWith("__reactProps$"));
    let owner = profileButton[fiberKey];
    if (owner?.alternate && owner.alternate.memoizedProps === profileButton[propsKey]) owner = owner.alternate;
    for (let fiber = owner; fiber; fiber = fiber.return) {
      const footer = fiber.memoizedProps?.sidebarFooter;
      if (!footer) continue;
      const identity = footer.profileIdentity;
      const name = identity?.displayName?.trim();
      if (!name) return null;
      return {
        type: "user", id: userId || userIdFromName(name), name,
        avatarUrl: await normalizeCodexAvatar(identity.profileImageUrl ?? null),
      };
    }
    const name = profileButton.textContent?.replace(/\s+/g, " ").trim();
    if (userId && name) {
      const avatar = profileButton.querySelector("img");
      return { type: "user", id: userId, name, avatarUrl: await normalizeCodexAvatar(avatar?.currentSrc || avatar?.src || null) };
    }
    // Older layouts may expose identity in an already-open menu. Reading it
    // must never open a settings menu as a side effect of opening Panel.
    const identity = readCodexProfileIdentity(profileButton);
    if (!identity) return null;
    return {
      type: "user",
      id: userId || userIdFromName(identity.name),
      name: identity.name,
      avatarUrl: await normalizeCodexAvatar(identity.avatarUrl),
    };
  }

  function readHostContext(projects = readCodexProjects(), preferredProjectId = lastNativeProjectId) {
    const row = activeThreadRow();
    const activeThreadId = normalizeThreadId(row?.getAttribute("data-app-action-sidebar-thread-id"));
    const projectList = row?.closest?.("[data-app-action-sidebar-project-list-id]");
    const projectRow = row?.closest?.("[data-app-action-sidebar-project-id]")
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute("data-app-action-sidebar-project-list-id")
      || projectRow?.getAttribute("data-app-action-sidebar-project-id")
      || preferredProjectId
      || "";
    const preferredThreadId = activeThreadId || lastNativeThreadId;
    const runningThreadId = normalizeThreadId(
      nativeRunningThreadRow(preferredThreadId, projectId)
        ?.getAttribute("data-app-action-sidebar-thread-id"),
    );
    const currentThreadId = activeThreadId || runningThreadId || lastNativeThreadId;
    if (activeThreadId || (!lastNativeThreadId && runningThreadId)) {
      lastNativeThreadId = currentThreadId;
    }
    const threadId = currentThreadId || lastNativeThreadId || normalizeThreadId(threadIdFromLocation());
    const workspacePath = workspaceFromLocation();
    const threadRunning = nativeThreadRunning(threadId);
    const payload = {
      theme: currentTheme(),
      projects,
      user: currentCodexUser ?? undefined,
      titlebarLeftInset: titlebarLeftInset(),
      sidebarCollapsed: nativeSidebarCollapsed(),
    };
    if (threadRunning !== undefined) payload.threadRunning = threadRunning;
    if (threadRunning) {
      const todoProgress = nativeTodoProgress();
      if (todoProgress) payload.threadTodoProgress = todoProgress;
    }
    if (workspacePath) payload.workspacePath = workspacePath;
    if (projectId) payload.projectId = projectId;
    if (threadId) payload.threadId = threadId;
    return payload;
  }

  function postToFrame(message, allowUnready = false) {
    if (!frame?.contentWindow || !frameOrigin || (!allowUnready && !frameReady)) return;
    frame.contentWindow.postMessage(message, frameOrigin === "null" ? "*" : frameOrigin);
  }

  function nativeThreadIds() {
    return new Set(
      Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
        .map((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")))
        .filter(Boolean),
    );
  }

  function markPendingThreadAssociationSubmitted(event) {
    const pending = pendingThreadAssociation;
    if (!pending || pending.submitted || Date.now() > pending.expiresAt) return;
    const editor = pending.composer;
    if (!editor?.isConnected) return;
    if (
      event.type === "keydown"
      && event.target === editor
      && event.key === "Enter"
      && !event.shiftKey
      && !event.isComposing
    ) {
      pending.submitted = true;
      persistPendingThreadAssociation();
      return;
    }
    const button = event.target?.closest?.("button");
    if (
      event.type === "click"
      && button
      && editor.closest("[data-codex-composer-root]")?.contains(button)
      && SEND_LABELS.includes(normalizedLabel(button.getAttribute("aria-label")))
    ) {
      pending.submitted = true;
      persistPendingThreadAssociation();
    }
  }

  async function publishPendingThreadAssociation() {
    if (!isTrustedPanelOrigin()) return;
    const pending = pendingThreadAssociation;
    if (!pending) return;
    if (Date.now() > pending.expiresAt) {
      setPendingThreadAssociation(null);
      return;
    }
    if (!pending.submitted || pending.confirming) return;
    const threadId = normalizeThreadId(threadIdFromLocation());
    if (!threadId || (pending.threadId ? threadId !== pending.threadId : pending.existingThreadIds.has(threadId))) return;
    if (
      pending.projectId
        ? !findThreadRowInProject(threadId, pending.projectId)
        : !findThreadRow(threadId)
    ) return;
    pending.confirming = true;
    try {
      const confirmed = await requestHost("confirm-task-conversation", {
        threadId,
        codexHostId: pending.codexHostId || "local",
        targetRoot: pending.workspacePath,
        identifier: pending.identifier,
        title: pending.title || pending.identifier,
        ...(pending.executionPreparation ? {
          executionPreparation: true,
          codexProjectId: pending.projectId,
          useWorktree: pending.useWorktree === true,
          previousTurnId: pending.previousTurnId,
        } : {}),
      }, TASK_CONVERSATION_REQUEST_TIMEOUT_MS);
      if (pendingThreadAssociation !== pending) return;
      setPendingThreadAssociation(null);
      lastNativeThreadId = threadId;
      postToFrame({
        type: "panel:thread-created",
        payload: { taskId: pending.taskId, threadId, ...(pending.executionPreparation ? {
          executionPreparation: true,
          planningPreparation: pending.planningPreparation === true,
          threadBinding: confirmed.threadBinding,
          developmentContext: pending.developmentContext ?? confirmed.developmentContext,
        } : {}) },
      });
    } catch (error) {
      if (pendingThreadAssociation !== pending) return;
      setPendingThreadAssociation(null);
      postToFrame({
        type: "panel:thread-create-error",
        payload: {
          taskId: pending.taskId,
          error: error instanceof Error ? error.message : "无法确认新建 Codex 对话",
        },
      });
    }
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function postFrameChallenge() {
    if (!frameChallenge) return;
    postToFrame({
      type: "panel:frame-challenge",
      payload: { challenge: frameChallenge },
    }, true);
  }

  function usesPrivateFrame() {
    return window.__CODEX_PANEL_PRIVATE_FRAME__ === true;
  }

  function postHostContext() {
    if (!frame) return;
    const theme = currentTheme();
    postToFrame({ type: "panel:theme", theme });
    if (!isTrustedPanelOrigin()) return;
    const liveContext = readHostContext();
    const payload = hostContextSnapshot
      ? {
          ...hostContextSnapshot,
          ...liveContext,
          projects: liveContext.projects.length > 0
            ? liveContext.projects
            : hostContextSnapshot.projects,
        }
      : liveContext;
    postToFrame({ type: "panel:host-context", payload });
  }

  function findThreadRow(threadId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)) || null;
  }

  function routeForThread(threadId) {
    return `/local/${encodeURIComponent(threadId)}`;
  }

  function threadRowProjectId(row) {
    return row?.closest?.("[data-app-action-sidebar-project-list-id]")
      ?.getAttribute("data-app-action-sidebar-project-list-id")
      || row?.closest?.("[data-app-action-sidebar-project-id]")
        ?.getAttribute("data-app-action-sidebar-project-id")
      || "";
  }

  function findThreadRowInProject(threadId, projectId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => (
        normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)
        && threadRowProjectId(row) === projectId
      )) || null;
  }

  async function waitForRemoteProject(projectId, hostId, workspacePath) {
    if (!projectId || !hostId || hostId === "local") {
      throw new Error("SSH 远程项目缺少精确的项目或主机标识");
    }
    await ensureProjectRows();
    const deadline = Date.now() + 8_000;
    let row = null;
    while (!row && Date.now() < deadline) {
      row = projectRowById(projectId);
      if (!row) await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    if (!row) throw new Error("Codex 中找不到精确的 SSH 远程项目");
    if (row.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
      row.click?.();
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    const selectProject = row.querySelector("[data-app-action-sidebar-select-project]");
    if (!selectProject) throw new Error("Codex 中找不到对应的 SSH 远程项目");
    selectProject.click?.();
    while (Date.now() < deadline) {
      const [selectedProjectId, metadata] = await Promise.all([
        selectedNativeProjectId(),
        readCodexProjectMetadata(),
      ]);
      const selectedProject = metadata.get(projectId);
      if (
        selectedProjectId === projectId
        && selectedProject?.projectKind === "remote"
        && selectedProject.hostId === hostId
        && (!workspacePath || selectedProject.workspacePath === workspacePath)
      ) {
        codexProjectMetadata = metadata;
        lastNativeProjectId = projectId;
        return row;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error("Codex 没有确认目标 SSH 远程项目和主机");
  }

  async function waitForRemoteThreadRow(threadId, projectId) {
    const deadline = Date.now() + 8_000;
    let row = findThreadRowInProject(threadId, projectId);
    while (!row && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      row = findThreadRowInProject(threadId, projectId);
    }
    return row;
  }

  async function openThread(payload) {
    const threadId = typeof payload?.threadId === "string" ? payload.threadId : "";
    if (typeof threadId !== "string" || !threadId.trim()) return;
    const normalizedThreadId = normalizeThreadId(threadId);
    if (payload?.codexProjectKind === "remote") {
      try {
        const projectId = typeof payload?.codexProjectId === "string" ? payload.codexProjectId.trim() : "";
        const hostId = typeof payload?.codexHostId === "string" ? payload.codexHostId.trim() : "";
        const workspacePath = typeof payload?.workspacePath === "string" ? payload.workspacePath.trim() : "";
        await waitForRemoteProject(projectId, hostId, workspacePath);
        const row = await waitForRemoteThreadRow(normalizedThreadId, projectId);
        if (!row?.isConnected) throw new Error("目标 SSH 远程项目中找不到该对话");
        lastNativeThreadId = normalizedThreadId;
        closePanel(false);
        row.click?.();
      } catch (error) {
        postToFrame({
          type: "panel:thread-open-error",
          payload: { error: error instanceof Error ? error.message : "无法打开 Codex 对话" },
        });
      }
      return;
    }
    lastNativeThreadId = normalizedThreadId;
    const row = findThreadRow(normalizedThreadId);
    closePanel(false);

    if (row?.isConnected) {
      row.click?.();
      return;
    }

    try {
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: routeForThread(normalizedThreadId),
      });
    } catch (_) {}
  }

  function projectRowById(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => row.getAttribute("data-app-action-sidebar-project-id") === projectId.trim()) || null;
  }

  async function nativeProjectContext() {
    const bootstrap = await window.electronBridge?.getInitialSidebarBootstrap?.();
    const entries = bootstrap?.globalStateEntries ?? [];
    const currentLocalProjects = await requestNativeFetch(
      "get-global-state",
      { key: "local-projects" },
    );
    const localProjects = currentLocalProjects === undefined
      ? entries.find((entry) => entry.key === "local-projects")?.value
      : currentLocalProjects?.value;
    const projectEntries = localProjects
      && typeof localProjects === "object"
      && !Array.isArray(localProjects)
      ? Object.entries(localProjects)
      : [];
    return {
      projects: projectEntries.flatMap(([id, project]) => (
        project && Array.isArray(project.rootPaths)
          ? [{ ...project, id }]
          : []
      )),
    };
  }

  async function resolveNativeProject(requestedProjectId, workspacePath) {
    const context = await nativeProjectContext();
    const normalizedWorkspacePath = normalizeNativeRootPath(workspacePath);
    let project = context.projects.find((candidate) => candidate.id === requestedProjectId) ?? null;
    if (!project && normalizedWorkspacePath) {
      const projectRoots = context.projects.flatMap((candidate) => candidate.rootPaths.flatMap((root) => (
        typeof root === "string" && normalizeNativeRootPath(root)
          ? [{ project: candidate, root }]
          : []
      )));
      const canonicalRoots = await canonicalNativeRootPaths([
        workspacePath,
        ...projectRoots.map(({ root }) => root),
      ]);
      const matchingRootIndex = canonicalRoots.slice(1).findIndex((root) => (
        root === canonicalRoots[0]
      ));
      if (matchingRootIndex >= 0) project = projectRoots[matchingRootIndex].project;
    }
    const targetRoot = normalizedWorkspacePath ? workspacePath : project?.rootPaths[0];
    return project && typeof targetRoot === "string" && normalizeNativeRootPath(targetRoot)
      ? { projectId: project.id, targetRoot }
      : null;
  }

  async function ensureProjectRows() {
    let section = findProjectsSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexProjects().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  async function waitForPreparedComposer(identifier, skills) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const editor = document.querySelector('[data-codex-composer="true"][contenteditable="true"]');
      if (editor && editor.getClientRects().length > 0) {
        const containsIdentifier = normalizedLabel(editor.textContent).includes(normalizedLabel(identifier));
        const mentions = Array.from(editor.querySelectorAll("[skill-mention-name]"));
        const skillsReady = skills.every((skill) => mentions.some((mention) => (
          mention.getAttribute("skill-mention-name") === skill.name
          && mention.getAttribute("skill-mention-path") === skill.path
        )));
        if (containsIdentifier && skillsReady) return editor;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error("Codex 对话输入框没有生成 manage-panel Skill 引用");
  }

  async function waitForNativeProject(targetRoot, expectedProjectId) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const [projectId, activeWorkspace] = await Promise.all([
        selectedNativeProjectId(),
        activeNativeWorkspaceRoots(),
      ]);
      if (projectId) {
        // Some Codex desktop builds no longer expose active-workspace-roots.
        // A confirmed selected project is still safe when that endpoint is unavailable;
        // keep rejecting an explicitly reported, mismatched workspace root.
        if (!activeWorkspace.available) {
          if (projectId === expectedProjectId) return projectId;
          await new Promise((resolve) => window.setTimeout(resolve, 80));
          continue;
        }
        const [canonicalTargetRoot, ...canonicalActiveRoots] = await canonicalNativeRootPaths([
          targetRoot,
          ...activeWorkspace.roots,
        ]);
        if (canonicalActiveRoots.some((root) => root === canonicalTargetRoot)) return projectId;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error(hostText(
      "Codex 未在限定时间内切换到目标项目或 worktree",
      "Codex did not switch to the target project or worktree in time",
    ));
  }

  async function selectNativeWorktree(useWorktree = true) {
    const labels = useWorktree ? NATIVE_WORKTREE_LABELS : ["local", "work locally", "本地", "本地模式", "本機", "本機作業"];
    const visibleLabel = (element) => normalizedLabel(element.innerText ?? element.textContent);
    const destination = useWorktree ? "新建本地工作树" : "本地目录";
    const readyDeadline = Date.now() + 4_000;
    let trigger;
    while (!trigger && Date.now() < readyDeadline) {
      trigger = Array.from(document.querySelectorAll(
        '[data-composer-navigation-target="run-location"]',
      )).find(isInteractiveElement);
      if (!trigger) await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
    if (!trigger) throw new Error("Codex 没有显示运行位置选择器");
    if (labels.includes(visibleLabel(trigger))) return;
    trigger.click();
    const deadline = Date.now() + 4_000;
    let menuOpened = false;
    let itemSelected = false;
    while (Date.now() < deadline) {
      const expanded = Array.from(document.querySelectorAll(
        '[data-composer-navigation-target="run-location"]',
      )).some((candidate) => (
        isInteractiveElement(candidate)
        && (
          candidate.getAttribute("aria-expanded") === "true"
          || candidate.getAttribute("data-state") === "open"
        )
      ));
      if (!expanded) {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        continue;
      }
      menuOpened = true;
      const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((candidate) => (
        isInteractiveElement(candidate)
        && labels.includes(visibleLabel(candidate))
      ));
      if (!item) {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        continue;
      }
      item.click();
      itemSelected = true;
      while (Date.now() < deadline) {
        const selected = Array.from(document.querySelectorAll(
          '[data-composer-navigation-target="run-location"]',
        )).find(isInteractiveElement);
        if (selected && labels.includes(visibleLabel(selected))) return;
        await new Promise((resolve) => window.setTimeout(resolve, 40));
      }
    }
    throw new Error(!menuOpened ? "Codex 运行位置菜单未打开"
      : !itemSelected ? `Codex 运行位置菜单中未找到${destination}`
        : `Codex 未确认已切换到${destination}`);
  }

  async function selectNativeCollaborationMode(mode, composer) {
    if (mode !== "plan" && mode !== "default") return;
    const root = composer.closest("[data-codex-composer-root]");
    if (!root) throw new Error("Codex 中找不到当前对话输入框");
    const planLabels = ["Plan", "计划", "計劃", "方案"];
    const isPlanMode = () => Array.from(root.querySelectorAll("button[aria-label]"))
      .some((button) => planLabels.includes(button.getAttribute("aria-label"))
        && isInteractiveElement(button));
    const expected = mode === "plan";
    if (isPlanMode() === expected) return;
    composer.focus();
    dispatchHostMessage({ type: "run-command", id: "composer.togglePlanMode" });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (isPlanMode() === expected) return;
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
    throw new Error(expected ? "Codex 没有切换到计划模式" : "Codex 没有退出计划模式");
  }

  async function createThreadForTask(payload) {
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const skillName = typeof payload?.skillName === "string" ? payload.skillName.trim() : "";
    const skillDisplayName = typeof payload?.skillDisplayName === "string"
      ? payload.skillDisplayName.trim()
      : "";
    const skillPath = typeof payload?.skillPath === "string" ? payload.skillPath.trim() : "";
    const rawSkillReferences = Array.isArray(payload?.skillReferences)
      ? payload.skillReferences
      : [{ name: skillName, displayName: skillDisplayName, path: skillPath }];
    const skillReferences = rawSkillReferences.length > 0
      && rawSkillReferences.length <= 41
      && rawSkillReferences.every((skill) => (
        typeof skill?.name === "string"
        && /^[a-z0-9_-]+(?::[a-z0-9_-]+)?$/i.test(skill.name.trim())
        && skill.name.trim().length <= 256
        && typeof skill?.displayName === "string"
        && skill.displayName.trim()
        && typeof skill?.path === "string"
        && skill.path.trim()
      ))
        ? rawSkillReferences.map((skill) => ({
            name: skill.name.trim(),
            displayName: skill.displayName.trim(),
            path: skill.path.trim(),
          }))
        : [];
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    const projectless = payload?.projectless === true;
    const codexProjectKind = payload?.codexProjectKind === "remote" ? "remote" : "local";
    const autoSubmit = payload?.autoSubmit === true;
    const reservationId = typeof payload?.reservationId === "string"
      ? payload.reservationId.trim()
      : "";
    if (
      !taskId
      || !identifier
      || !title
      || !instruction
      || (codexProjectKind === "local" && skillReferences.length === 0)
      || (autoSubmit && (!reservationId || projectless || codexProjectKind !== "local"))
      || pendingThreadCreation
    ) return;
    pendingThreadCreation = taskId;
    setPendingThreadAssociation(null);
    try {
      if (!payload.newConversation && !autoSubmit && payload.executionPreparation && payload.threadBinding) {
        const binding = payload.threadBinding;
        await openThread(binding);
        const deadline = Date.now() + 8_000;
        while (normalizeThreadId(threadIdFromLocation()) !== binding.threadId && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 40));
        }
        if (normalizeThreadId(threadIdFromLocation()) !== binding.threadId) {
          throw new Error("Codex 未确认已切换到绑定对话");
        }
        const prepared = await requestHostTaskComposerPrefill({
          instruction, skills: skillReferences, threadId: binding.threadId,
        });
        const composer = await waitForPreparedComposer(identifier, []);
        await selectNativeCollaborationMode(payload.collaborationMode === "plan" ? "plan" : "default", composer);
        setPendingThreadAssociation({
          taskId, identifier, title, composer, existingThreadIds: nativeThreadIds(),
          threadId: binding.threadId, previousTurnId: prepared.previousTurnId,
          developmentContext: payload.developmentContext,
          executionPreparation: true, useWorktree: false,
          planningPreparation: payload.planningPreparation === true,
          projectId: binding.codexProjectId, codexHostId: binding.codexHostId,
          workspacePath: binding.workspacePath, submitted: false, confirming: false,
          expiresAt: Date.now() + THREAD_ASSOCIATION_TIMEOUT_MS,
        });
        postToFrame({ type: "panel:thread-prepared", payload: { taskId } });
        return;
      }
      if (autoSubmit && payload.threadBinding) {
        const binding = payload.threadBinding;
        const started = await requestHost("start-task-conversation", {
          taskId,
          threadId: binding.threadId,
          previousThreadId: binding.threadId,
          codexProjectId: binding.codexProjectId,
          codexHostId: binding.codexHostId,
          targetRoot: binding.workspacePath,
          projectless: false,
          instruction,
          title,
          useWorktree: false,
          skills: skillReferences,
          collaborationMode: "default",
        }, TASK_CONVERSATION_REQUEST_TIMEOUT_MS);
        await requestHost("bind-native-claim", {
          reservationId,
          taskId,
          threadBinding: started.threadBinding,
          developmentContext: payload.developmentContext,
        });
        await openThread(started.threadBinding);
        return;
      }
      if (!payload.newConversation && payload?.recoverExisting === true && !autoSubmit) {
        const codexHostId = typeof payload?.codexHostId === "string"
          ? payload.codexHostId.trim() || "local"
          : "local";
        const recovery = await requestHost("find-task-conversations", {
          codexHostId,
          identifier,
        }, TASK_CONVERSATION_REQUEST_TIMEOUT_MS);
        const matches = Array.isArray(recovery?.matches) ? recovery.matches : [];
        const currentThreadId = normalizeThreadId(threadIdFromLocation() || lastNativeThreadId);
        const recovered = matches.find((match) => (
          normalizeThreadId(match?.threadId) === currentThreadId
        )) ?? (matches.length === 1 ? matches[0] : null);
        if (matches.length > 1 && !recovered) {
          throw new Error(`发现多个 ${identifier} 对话，请先打开要关联的对话后重试`);
        }
        if (typeof recovered?.threadId === "string" && recovered.threadId.trim()) {
          postToFrame({
            type: "panel:thread-created",
            payload: { taskId, threadId: recovered.threadId.trim() },
          });
          return;
        }
      }

      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error("当前 Codex 版本没有提供原生对话导航能力");
      }

      if (!projectless && codexProjectKind === "remote") {
        const requestedProjectId = typeof payload?.codexProjectId === "string"
          ? payload.codexProjectId.trim()
          : "";
        const codexHostId = typeof payload?.codexHostId === "string"
          ? payload.codexHostId.trim()
          : "";
        const targetRoot = typeof payload?.codexProjectWorkspacePath === "string"
          ? payload.codexProjectWorkspacePath.trim()
          : "";
        await waitForRemoteProject(requestedProjectId, codexHostId, targetRoot);
        closePanel(false);
        const existingThreadIds = nativeThreadIds();
        await dispatchHostMessage({
          type: "navigate-to-route",
          path: "/",
          state: {
            focusComposerNonce: crypto.randomUUID(),
            prefillPrompt: instruction,
          },
        });
        const composer = await waitForPreparedComposer(identifier, []);
        await selectNativeCollaborationMode(payload.collaborationMode, composer);
        setPendingThreadAssociation({
          taskId,
          identifier,
          title,
          composer,
          existingThreadIds,
          projectId: requestedProjectId,
          codexHostId,
          workspacePath: targetRoot,
          submitted: false,
          confirming: false,
          expiresAt: Date.now() + THREAD_ASSOCIATION_TIMEOUT_MS,
        });
        postToFrame({ type: "panel:thread-prepared", payload: { taskId } });
        return;
      }

      const previousThreadId = normalizeThreadId(threadIdFromLocation() || lastNativeThreadId);
      if (!projectless) {
        const requestedProjectId = typeof payload.codexProjectId === "string"
          ? payload.codexProjectId.trim()
          : "";
        const target = await resolveNativeProject(requestedProjectId, workspacePath);
        if (!target) {
          throw new Error(hostText(
            "Codex 中没有映射目标项目或 worktree",
            "The target project or worktree is not mapped in Codex",
          ));
        }
        await ensureProjectRows();
        const row = projectRowById(target.projectId);
        if (!row) throw new Error("Codex 中找不到对应的本地项目");
        if (row.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
          row.click?.();
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        const selectProject = row.querySelector("[data-app-action-sidebar-select-project]");
        if (!selectProject) throw new Error("Codex 中找不到对应的本地项目");
        selectProject.click?.();
        lastNativeProjectId = await waitForNativeProject(target.targetRoot, target.projectId);
      }

      closePanel(false);
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: "/",
        state: {
          focusComposerNonce: Date.now(),
          ...(projectless ? { project: null } : {}),
        },
      });
      const existingThreadIds = nativeThreadIds();
      if (payload.newConversation) {
        const deadline = Date.now() + 8_000;
        let ready = false;
        while (Date.now() < deadline) {
          ready = Array.from(document.querySelectorAll(
            '[data-codex-composer-root][data-composer-placement="home"] [data-codex-composer="true"][contenteditable="true"]'
          )).some((editor) => editor.getClientRects().length > 0);
          if (ready) break;
          await new Promise((resolve) => window.setTimeout(resolve, 40));
        }
        if (!ready) throw new Error("Codex 未打开新对话输入框");
      }
      if (autoSubmit || payload.executionPreparation) {
        await selectNativeWorktree(payload.useWorktree !== false);
      }
      await requestHostTaskComposerPrefill({
        instruction,
        skillDisplayName,
        skillName,
        skillPath,
        skills: skillReferences,
      });
      const composer = await waitForPreparedComposer(identifier, []);
      await selectNativeCollaborationMode(autoSubmit ? "default" : payload.collaborationMode, composer);
      const selectedProjectId = projectless
        ? ""
        : (await selectedNativeProjectId()) || payload.codexProjectId;
      if (autoSubmit) {
        const started = await requestHostTaskConversationStart({
          taskId,
          previousThreadId,
          codexProjectId: selectedProjectId,
          codexHostId: "local",
          targetRoot: workspacePath,
          projectless: false,
          instruction,
          title,
          useWorktree: payload?.useWorktree !== false,
        });
        await requestHost("bind-native-claim", {
          reservationId,
          taskId,
          threadBinding: started.threadBinding,
          developmentContext: started.developmentContext ?? null,
        });
        return;
      }
      setPendingThreadAssociation({
        taskId,
        identifier,
        title,
        composer,
        existingThreadIds,
        projectId: selectedProjectId,
        codexHostId: "local",
        workspacePath,
        executionPreparation: payload.executionPreparation === true,
        planningPreparation: payload.planningPreparation === true,
        useWorktree: payload.useWorktree === true,
        submitted: false,
        confirming: false,
        expiresAt: Date.now() + THREAD_ASSOCIATION_TIMEOUT_MS,
      });
      postToFrame({ type: "panel:thread-prepared", payload: { taskId } });
    } catch (error) {
      if (autoSubmit && reservationId) {
        try {
          await requestHost("fail-native-claim", {
            reservationId,
            taskId,
            error: error instanceof Error ? error.message : "无法创建 Codex 对话",
          });
          // The queue owns execution errors and clears them after a confirmed
          // takeover; a second global banner would outlive that recovery.
          return;
        } catch (_) {}
      }
      postToFrame({
        type: "panel:thread-create-error",
        payload: {
          taskId,
          error: error instanceof Error ? error.message : "无法创建 Codex 对话",
          ...(typeof error?.threadId === "string" ? { threadId: error.threadId } : {}),
          ...(error?.uncertain === true ? { uncertain: true } : {}),
        },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  function buildAutomationHostPayload(payload) {
    return {
      requestId: payload.requestId,
      operation: payload.operation,
      panelProjectId: payload.panelProjectId,
      codexProjectId: payload.codexProjectId,
      projectName: payload.projectName,
      workspacePath: payload.workspacePath,
      skillPath: payload.skillPath,
      ...(payload.automationId === undefined ? {} : { automationId: payload.automationId }),
      enabledByUser: payload.enabledByUser,
      quotaAware: payload.quotaAware,
      intervalMinutes: payload.intervalMinutes,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
    };
  }

  async function handleAutomationRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    if (!isTrustedPanelOrigin()) {
      postToFrame({
        type: "panel:automation-response",
        payload: { requestId, ok: false, error: "仅本地任务面板可用" },
      });
      return;
    }
    try {
      const response = await requestHost(
        "automation",
        buildAutomationHostPayload(payload),
      );
      postToFrame({
        type: "panel:automation-response",
        payload: response.error
          ? { requestId, ok: false, error: response.error }
          : {
              requestId,
              ok: true,
              item: response.item,
              items: response.items,
              quota: response.quota,
              idleReason: response.idleReason,
              policy: response.policy,
              state: response.state,
              run: response.run,
            },
      });
    } catch (error) {
      postToFrame({
        type: "panel:automation-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "Codex 自动任务操作失败",
        },
      });
    }
  }

  function handleExternalOpen(payload) {
    try {
      const url = new URL(payload?.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      void requestHost("open-external", { url: url.href }).catch(() => {});
    } catch (_) {}
  }

  async function handleAttachmentOpen(payload) {
    try {
      const result = await requestHost("open-attachment", {
        attachmentId: payload?.attachmentId,
        filename: payload?.filename,
        operation: payload?.operation,
      });
      postToFrame({
        type: "panel:attachment-local-path",
        payload: {
          attachmentId: payload?.attachmentId,
          filename: payload?.filename,
          localPath: result.localPath ?? null,
        },
      });
    } catch (_) {
      postToFrame({
        type: "panel:attachment-local-path",
        payload: { attachmentId: payload?.attachmentId, filename: payload?.filename, localPath: null },
      });
      if (payload?.operation === "local-path") return;
      postToFrame({
        type: "panel:attachment-open-error",
        payload: {
          error: "无法显示附件所在位置，请重新打开附件后重试。",
        },
      });
    }
  }

  function handleDatePickerRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    const value = typeof payload?.value === "string" ? payload.value : "";
    const rect = payload?.rect;
    if (
      !requestId
      || !frame
      || !rect
      || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    ) return;

    const frameRect = frame.getBoundingClientRect();
    const input = document.createElement("input");
    input.type = "date";
    input.value = value;
    input.style.position = "fixed";
    input.style.left = `${frameRect.left + rect.x}px`;
    input.style.top = `${frameRect.top + rect.y}px`;
    input.style.width = `${rect.width}px`;
    input.style.height = `${rect.height}px`;
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.append(input);
    input.addEventListener("change", () => {
      postToFrame({
        type: "taskboard:date-picker-response",
        payload: { requestId, value: input.value },
      });
      input.remove();
    }, { once: true });
    input.getBoundingClientRect();
    input.showPicker();
  }

  function challengeFrameDocument(event) {
    if (!frame || event.currentTarget !== frame) return;
    frameReady = false;
    frameChallenge = crypto.randomUUID();
    if (active) showLoading();
    postFrameChallenge();
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const message = event.data;
    if (!usesPrivateFrame()) {
      if (!message || typeof message !== "object") return;
      if (message.type === "panel:frame-awaiting-challenge" || message.type === "taskboard:frame-awaiting-challenge") {
        frameChallenge = crypto.randomUUID();
        postFrameChallenge();
        return;
      }
      if (message.type === "panel:ready") {
        frameReady = true;
        frameReadyWaiters.forEach(({ resolve, timer }) => {
          window.clearTimeout(timer);
          resolve();
        });
        frameReadyWaiters.clear();
        if (active) showFrame();
        postHostContext();
        return;
      }
    } else {
    if (
      !message
      || typeof message !== "object"
      || !frameCapability
      || message.capability !== frameCapability
    ) return;
    if (message.type === "panel:frame-awaiting-challenge" || message.type === "taskboard:frame-awaiting-challenge") {
      if (!frameChallenge) frameChallenge = crypto.randomUUID();
      postFrameChallenge();
      return;
    }
    if (!frameChallenge || message.challenge !== frameChallenge) return;
    if (message.type === "panel:ready" || message.type === "taskboard:ready") {
      if (frameReady) return;
      frameReady = true;
      frameReadyWaiters.forEach(({ resolve, timer }) => {
        window.clearTimeout(timer);
        resolve();
      });
      frameReadyWaiters.clear();
      if (active) showFrame();
      postHostContext();
      return;
    }
    }
    if (message.type === "panel:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (!isTrustedPanelOrigin()) return;
    if (message.type === "panel:open-thread" || message.type === "taskboard:open-thread") {
      void openThread(message.payload);
      return;
    }
    if (message.type === "panel:expand-sidebar") {
      expandNativeSidebar();
      return;
    }
    if (message.type === "panel:automation-request") {
      void handleAutomationRequest(message.payload);
      return;
    }
    if (message.type === "panel:open-external" || message.type === "taskboard:open-external") {
      handleExternalOpen(message.payload);
      return;
    }
    if (message.type === "panel:open-attachment" || message.type === "taskboard:open-attachment") {
      void handleAttachmentOpen(message.payload);
      return;
    }
    if (message.type === "panel:date-picker-request" || message.type === "taskboard:date-picker-request") {
      handleDatePickerRequest(message.payload);
      return;
    }
    if (message.type === "panel:create-thread" || message.type === "taskboard:create-thread") {
      void createThreadForTask(message.payload);
    }
  }

  function updateDragRegion(payload) {
    if (!dragRegion || !noDragLeft || !noDragRight) return;
    const [x, y, width, height] = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      dragRegion.hidden = true;
      noDragLeft.hidden = true;
      noDragRight.hidden = true;
      return;
    }
    const left = Math.max(0, x);
    const right = left + width;
    dragRegion.style.left = `${left}px`;
    dragRegion.style.top = `${Math.max(0, y)}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${height}px`;
    noDragLeft.style.left = "0";
    noDragLeft.style.top = `${Math.max(0, y)}px`;
    noDragLeft.style.width = `${left}px`;
    noDragLeft.style.height = `${height}px`;
    noDragRight.style.left = `${right}px`;
    noDragRight.style.top = `${Math.max(0, y)}px`;
    noDragRight.style.right = "0";
    noDragRight.style.height = `${height}px`;
    dragRegion.hidden = false;
    noDragLeft.hidden = left <= 0;
    noDragRight.hidden = right >= page.clientWidth;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "任务面板");

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);

    noDragLeft = document.createElement("div");
    noDragLeft.id = NO_DRAG_LEFT_ID;
    noDragLeft.hidden = true;
    noDragLeft.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragLeft.setAttribute("aria-hidden", "true");
    section.appendChild(noDragLeft);

    noDragRight = document.createElement("div");
    noDragRight.id = NO_DRAG_RIGHT_ID;
    noDragRight.hidden = true;
    noDragRight.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragRight.setAttribute("aria-hidden", "true");
    section.appendChild(noDragRight);
    return section;
  }

  function showLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode("正在启动任务面板…"));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
  }

  function showLoadError(message) {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新加载";
    retry.addEventListener("click", showPanel);
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function cancelFrameReadyWaiters(error) {
    frameReadyWaiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(error);
    });
    frameReadyWaiters.clear();
  }

  function waitForFrameReady() {
    if (frameReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          frameReadyWaiters.delete(waiter);
          reject(new Error("任务面板页面加载超时"));
        }, FRAME_READY_TIMEOUT_MS),
      };
      frameReadyWaiters.add(waiter);
    });
  }

  function loadPanelFrame(cacheBust = false) {
    cancelFrameReadyWaiters(new Error("任务面板正在重新加载"));
    frame?.remove();
    frame = null;
    framePanelUrl = "";
    frameCapability = "";
    frameChallenge = "";
    frameReady = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;

    const panelUrl = resolvePanelUrl();
    if (cacheBust) {
      panelUrl.searchParams.set(FRAME_REFRESH_PARAM, Date.now().toString(36));
    }
    panelOrigin = panelUrl.origin;
    framePanelUrl = panelUrl.href;
    const privateFrame = usesPrivateFrame();
    frameOrigin = privateFrame ? "null" : panelUrl.origin;
    const frameName = privateFrame ? `codex-panel-${crypto.randomUUID()}` : "";
    frameCapability = privateFrame ? crypto.randomUUID() : "";
    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    if (frameName) nextFrame.name = frameName;
    nextFrame.hidden = true;
    if (privateFrame) {
      nextFrame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads");
      nextFrame.src = "about:blank";
      nextFrame.addEventListener("load", challengeFrameDocument);
    } else {
      nextFrame.src = panelUrl.href;
      nextFrame.setAttribute(
        "allow",
        "clipboard-read; clipboard-write; local-network-access; loopback-network; local-network",
      );
      nextFrame.addEventListener("load", postHostContext);
    }
    nextFrame.title = "任务面板";
    nextFrame.referrerPolicy = "no-referrer";
    if (privateFrame) nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    frame = nextFrame;
    page.appendChild(nextFrame);
    return { frameName, frameCapability };
  }

  function reloadFrame() {
    if (!frame) return false;
    const generation = ++openGeneration;
    if (active) showLoading();
    const frameRequest = loadPanelFrame(true);
    void (usesPrivateFrame() ? requestHostLoadFrame(frameRequest) : Promise.resolve())
      .then(() => waitForFrameReady())
      .then(() => {
          if (!active || generation !== openGeneration) return;
          showFrame();
          postHostContext();
      })
      .catch((error) => {
        if (!active || generation !== openGeneration) return;
        showLoadError(error.message);
      });
    return true;
  }

  function managedPanelOrigin() {
    const configuredValue = typeof window.__CODEX_PANEL_MANAGED_ORIGIN__ === "string"
      ? window.__CODEX_PANEL_MANAGED_ORIGIN__
      : window.__CODEX_TASKBOARD_MANAGED_ORIGIN__;
    const configured = typeof configuredValue === "string" ? configuredValue.trim() : "";
    try {
      return new URL(configured || DEFAULT_PANEL_URL).origin;
    } catch (_) {
      return new URL(DEFAULT_PANEL_URL).origin;
    }
  }

  function isTrustedPanelOrigin(origin = panelOrigin || frameOrigin) {
    return Boolean(origin) && origin === managedPanelOrigin();
  }

  function hasLiveHostBinding() {
    return typeof HOST_CAPABILITY === "string"
      && HOST_CAPABILITY.length > 0
      && Number.isFinite(hostHeartbeatAt)
      && Date.now() - hostHeartbeatAt <= HOST_HEARTBEAT_MAX_AGE_MS;
  }

  async function waitForLiveHostBinding() {
    const deadline = Date.now() + HOST_BINDING_READY_TIMEOUT_MS;
    while (!hasLiveHostBinding() && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (!hasLiveHostBinding()) {
      throw new Error("Codex 桥接尚未就绪，请稍后重试");
    }
  }

  async function requestHost(action, payload = {}, timeoutMs = HOST_REQUEST_TIMEOUT_MS) {
    await waitForLiveHostBinding();
    const id = `${Date.now().toString(36)}-${(++hostRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs === null
        ? null
        : window.setTimeout(() => {
            hostRequests.delete(id);
            const error = new Error("任务面板启动器没有响应");
            if (action === "start-task-conversation") error.uncertain = true;
            reject(error);
          }, timeoutMs);
      hostRequests.set(id, { resolve, reject, timeout });
      try {
        window.postMessage({
          type: HOST_REQUEST_MESSAGE,
          capability: HOST_CAPABILITY,
          payload: { ...payload, id, action },
        }, window.location.origin);
      } catch (error) {
        if (timeout !== null) window.clearTimeout(timeout);
        hostRequests.delete(id);
        reject(error);
      }
    });
  }

  function requestHostEnsure(panelUrl) {
    if (panelUrl.origin !== managedPanelOrigin() || !hasLiveHostBinding()) {
      return Promise.resolve({ managed: false, restarted: false });
    }
    return requestHost("ensure");
  }

  function requestHostLoadFrame({ frameName, frameCapability: capability }) {
    return requestHost("load-frame", { frameName, frameCapability: capability });
  }

  function requestHostTaskComposerPrefill({ instruction, skillDisplayName, skillName, skillPath, skills, threadId }) {
    return requestHost("prefill-task-composer", {
      instruction,
      skillDisplayName,
      skillName,
      skillPath,
      skills,
      ...(threadId ? { threadId } : {}),
    }, COMPOSER_PREFILL_REQUEST_TIMEOUT_MS);
  }

  function requestHostTaskConversationStart({
    taskId,
    previousThreadId,
    codexProjectId,
    codexHostId,
    targetRoot,
    projectless = !targetRoot,
    instruction,
    title,
    useWorktree = false,
  }) {
    return requestHost("start-task-conversation", {
      taskId,
      previousThreadId,
      codexProjectId,
      codexHostId,
      targetRoot,
      projectless,
      instruction,
      title,
      useWorktree,
    }, TASK_CONVERSATION_REQUEST_TIMEOUT_MS);
  }

  async function pollNativeClaim() {
    if (
      nativeClaimPollInFlight
      || pendingThreadCreation
      || (pendingThreadAssociation && Date.now() <= pendingThreadAssociation.expiresAt)
      || !hasLiveHostBinding()
    ) return;
    nativeClaimPollInFlight = true;
    try {
      const response = await requestHost("next-native-claim");
      if (response?.claim) await createThreadForTask(response.claim);
    } catch (_) {
      // The next heartbeat retries after the launcher or Panel service recovers.
    } finally {
      nativeClaimPollInFlight = false;
    }
  }

  function frameMatchesPanelUrl(panelUrl) {
    if (!frame || !framePanelUrl) return false;
    try {
      const loadedUrl = new URL(framePanelUrl);
      loadedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      const expectedUrl = new URL(panelUrl.href);
      expectedUrl.searchParams.delete(FRAME_REFRESH_PARAM);
      return loadedUrl.href === expectedUrl.href;
    } catch (_) {
      return false;
    }
  }

  function onHostResponse(response) {
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = hostRequests.get(response.id);
    if (!pending) return;
    if (pending.timeout !== null) window.clearTimeout(pending.timeout);
    hostRequests.delete(response.id);
    if (response.ok) pending.resolve(response);
    else {
      const error = new Error(response.error || "任务面板服务启动失败");
      if (typeof response.threadId === "string") error.threadId = response.threadId;
      if (response.uncertain === true) error.uncertain = true;
      pending.reject(error);
    }
  }

  function onHostBridgeMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.capability !== HOST_CAPABILITY) return;
    if (message.type === HOST_HEARTBEAT_MESSAGE) {
      hostHeartbeatAt = Number(message.at) || 0;
      hideUsageBanner = message.hideUsageBanner === true;
      window.__codexPanelProviderQuotaV1__?.setEnabled(message.customProviderQuotaFix === true);
      syncUsageBannerVisibility();
      window[HOST_STARTUP_TOKEN_NAME] = message.startupToken ?? null;
      return;
    }
    if (message.type === HOST_RESPONSE_MESSAGE) onHostResponse(message.response);
  }

  async function preparePanel(generation) {
    const panelUrl = resolvePanelUrl();
    // Capture the current identity before displaying a reused frame.
    showLoading();

    try {
      const [result, context] = await Promise.all([
        requestHostEnsure(panelUrl),
        isTrustedPanelOrigin(panelUrl.origin)
          ? captureHostContext()
          : Promise.resolve(null),
      ]);
      if (!active || generation !== openGeneration) return;
      currentCodexUser = context?.user ?? null;
      hostContextSnapshot = {
        ...hostContextSnapshot,
        ...context,
        projects: context?.projects?.length > 0
          ? context.projects
          : hostContextSnapshot?.projects ?? [],
      };
      if (!frameReady || result.restarted || !frameMatchesPanelUrl(panelUrl)) {
        showLoading();
        const frameRequest = loadPanelFrame();
        if (usesPrivateFrame()) await requestHostLoadFrame(frameRequest);
        await waitForFrameReady();
      }
      if (!active || generation !== openGeneration) return;
      showFrame();
      postHostContext();
    } catch (error) {
      if (!active || generation !== openGeneration) return;
      const bindingAvailable = hasLiveHostBinding();
      showLoadError(bindingAvailable
        ? error.message
        : "未连接到 Panel 启动器。请在 Codex Panel 中启动或重启服务，然后点击“重新加载”。");
    }
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function closeNativeBrowserPanel() {
    if (suspendedNativeBrowserPanel) return;
    const browserPanel = Array.from(
      document.querySelectorAll("[data-browser-sidebar-webview]"),
    ).find((node) => window.getComputedStyle(node).visibility !== "hidden");
    if (!browserPanel) return;
    const webview = browserPanel.querySelector("webview");
    suspendedNativeBrowserPanel = {
      conversationId: webview?.getAttribute("data-browser-sidebar-conversation-id") || null,
      browserTabId: webview?.getAttribute("data-browser-sidebar-browser-tab-id") || null,
    };
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "toggle-browser-panel",
        open: false,
        source: "manual",
        initiator: "panel_open",
      },
    }));
  }

  function restoreNativeBrowserPanel() {
    const browserPanel = suspendedNativeBrowserPanel;
    suspendedNativeBrowserPanel = null;
    if (!browserPanel) return;
    const data = {
      type: "toggle-browser-panel",
      open: true,
      source: "manual",
      initiator: "panel_close",
    };
    if (browserPanel.conversationId) data.conversationId = browserPanel.conversationId;
    if (browserPanel.browserTabId) data.browserTabId = browserPanel.browserTabId;
    window.dispatchEvent(new MessageEvent("message", { data }));
  }

  function mountActivePage() {
    if (!active) return false;
    if (!page) page = createPage();
    const mount = findPageMount();
    if (!mount) return false;
    const { surface, rail } = mount;

    let remounted = false;
    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
      // Moving the page rebuilds the frame's browsing context, so the document
      // the host installed with Page.setDocumentContent is gone for good.
      if (frame) {
        frameReady = false;
        remounted = true;
      }
    }
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    page.style.left = rail ? `${rail.getBoundingClientRect().right - surface.getBoundingClientRect().left}px` : "0px";
    page.style.top = rail ? "" : "0px";
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    syncNativeRailIcons();
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-panel-open", "true");
    return remounted;
  }

  function closePanel(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    openGeneration += 1;
    active = false;
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeBrowserPanel();
    restoreNativeRailIcons();
    document.documentElement.removeAttribute("data-codex-panel-open");
    syncEntryState();
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    hostContextSnapshot = null;
  }

  function showPanel() {
    if (destroyed) return;
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = readHostContext();
    }
    const generation = ++openGeneration;
    active = true;
    closeNativeBrowserPanel();
    ensureEntry();
    mountActivePage();
    syncEntryState();
    void preparePanel(generation);
  }

  function connectNativeNavigation() {
    if (nativeNavigator) return true;
    const surface = document.querySelector("aside") || document.querySelector("main");
    const fiberKey = surface && Object.keys(surface).find((key) => key.startsWith("__reactFiber$"));
    // Codex's MemoryRouter exposes its navigator through the ancestor Router props.
    // Do not call listen(): memory history has a single listener owned by React.
    for (let fiber = surface?.[fiberKey]; fiber; fiber = fiber.return) {
      const props = fiber.memoizedProps;
      // 新版 Data Router 的 navigator 没有 location；通过 router 的状态与订阅跟随原生导航。
      const router = props?.router || props?.value?.router;
      if (router?.state?.location && typeof router.navigate === "function" && typeof router.subscribe === "function") {
        nativeNavigator = {
          get location() { return router.state.location; },
          get action() { return router.state.historyAction; },
          push(path, state) { return router.navigate(path, { state }); },
          go(delta) { return router.navigate(delta); },
        };
        const unsubscribe = router.subscribe(syncNativeNavigation);
        detachNativeNavigation = () => {
          unsubscribe();
          nativeNavigator = null;
        };
        return true;
      }
      const navigator = props?.navigator || props?.value?.navigator;
      if (!navigator?.location || !["push", "replace", "go"].every((name) => typeof navigator[name] === "function")) continue;
      nativeNavigator = navigator;
      const restore = [];
      for (const name of ["push", "replace", "go"]) {
        const original = navigator[name];
        const wrapped = function (...args) {
          const result = original.apply(this, args);
          syncNativeNavigation();
          return result;
        };
        navigator[name] = wrapped;
        restore.push(() => { if (navigator[name] === wrapped) navigator[name] = original; });
      }
      detachNativeNavigation = () => {
        restore.forEach((restoreMethod) => restoreMethod());
        nativeNavigator = null;
      };
      return true;
    }
    return false;
  }

  function syncNativeNavigation() {
    if (destroyed || !nativeNavigator) return;
    const location = nativeNavigator.location;
    if (location === lastNativeLocation) return;
    const previousLocation = lastNativeLocation;
    lastNativeLocation = location;
    // Codex replaces route state in place and assigns a new key after Panel opens.
    if (nativeNavigator.action === "REPLACE"
      && panelLocationKeys.has(previousLocation?.key)
      && location.state?.[PANEL_ROUTE_STATE] === true
      && location.pathname === previousLocation.pathname
      && location.search === previousLocation.search
      && location.hash === previousLocation.hash) {
      panelLocationKeys.delete(previousLocation.key);
      panelLocationKeys.add(location.key);
    }
    const match = location.pathname.match(/^\/local\/([^/]+)$/);
    if (match) lastNativeThreadId = normalizeThreadId(decodeURIComponent(match[1]));
    // Native destinations copy cached route state into new history entries.
    // Only history keys created by opening Panel may restore it.
    if (pendingPanelNavigation && location.state?.[PANEL_ROUTE_STATE] === true) {
      panelLocationKeys.add(location.key);
      pendingPanelNavigation = false;
    }
    if (location.state?.[PANEL_ROUTE_STATE] === true && panelLocationKeys.has(location.key)) {
      if (!active) showPanel();
    } else if (active) {
      closePanel(false);
    }
    void publishPendingThreadAssociation();
  }

  async function openPanel() {
    if (destroyed || active || pendingPanelNavigation) return;
    if (!connectNativeNavigation()) {
      throw new Error("无法连接 Codex 原生导航，请等待页面加载后重试");
    }
    const { pathname, search, hash, state } = nativeNavigator.location;
    if (state?.[PANEL_ROUTE_STATE] === true && panelLocationKeys.has(nativeNavigator.location.key)) {
      showPanel();
    } else {
      pendingPanelNavigation = true;
      try {
        await nativeNavigator.push({ pathname, search, hash }, { [PANEL_ROUTE_STATE]: true });
      } finally {
        pendingPanelNavigation = false;
      }
    }
  }

  function leavePanel() {
    if (nativeNavigator?.location.state?.[PANEL_ROUTE_STATE] === true) {
      nativeNavigator.go(-1);
    } else {
      closePanel();
    }
  }

  function onDocumentClick(event) {
    const destination = event.target?.closest?.('nav[data-app-navigation-rail] [data-sidebar-destination]');
    if (destination) pendingPanelNavigation = false;
    if (!active || destination?.getAttribute("aria-current") !== "page") return;
    event.preventDefault();
    event.stopPropagation();
    const { pathname, search, hash, state } = nativeNavigator.location;
    nativeNavigator.push({ pathname, search, hash }, { ...state, [PANEL_ROUTE_STATE]: false });
  }

  function scheduleRefresh() {
    if (destroyed) return;
    syncUsageBannerVisibility();
    if (reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      connectNativeNavigation();
      syncNativeNavigation();
      ensureEntry();
      if (mountActivePage()) reloadFrame();
      void publishPendingThreadAssociation();
      postHostContext();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    connectNativeNavigation();
    syncNativeNavigation();
    syncUsageBannerVisibility();
    ensureEntry();
    if (mountActivePage()) reloadFrame();
    void publishPendingThreadAssociation();
    postHostContext();
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    connectNativeNavigation();
    syncNativeNavigation();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "inert",
        "hidden",
        "class",
        "data-theme",
        "data-color-theme",
        "data-app-action-sidebar-thread-active",
        "aria-label",
        "aria-current",
        "data-selected",
      ],
    });
    hostContextTimer = window.setInterval(() => {
      postHostContext();
      void pollNativeClaim();
    }, 1_000);
    postHostContext();
    void pollNativeClaim();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (reattachTimer !== null) window.clearTimeout(reattachTimer);
    reattachTimer = null;
    if (hostContextTimer !== null) window.clearInterval(hostContextTimer);
    hostContextTimer = null;
    detachNativeNavigation?.();
    detachNativeNavigation = null;
    observer?.disconnect();
    observer = null;
    hideUsageBanner = false;
    syncUsageBannerVisibility();
    cancelFrameReadyWaiters(new Error("任务面板已关闭"));
    hostRequests.forEach(({ reject, timeout }) => {
      window.clearTimeout(timeout);
      reject(new Error("任务面板已关闭"));
    });
    hostRequests.clear();
    pendingThreadCreation = null;
    pendingThreadAssociation = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("click", markPendingThreadAssociationSubmitted, true);
    document.removeEventListener("keydown", markPendingThreadAssociationSubmitted, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("message", onHostBridgeMessage);
    window.removeEventListener("resize", scheduleRefresh);
    closePanel(false);
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    page = null;
    frame = null;
    dragRegion = null;
    noDragLeft = null;
    noDragRight = null;
    status = null;
    frameOrigin = "";
    panelOrigin = "";
    framePanelUrl = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    hostCapability: HOST_CAPABILITY,
    panelLocationKeys,
    get ready() {
      return frameReady;
    },
    get heartbeatAt() {
      return hostHeartbeatAt || null;
    },
    get startupToken() {
      return window[HOST_STARTUP_TOKEN_NAME] ?? null;
    },
    refresh,
    reloadFrame,
    open: openPanel,
    close: leavePanel,
    destroy,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("message", onHostBridgeMessage);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("click", markPendingThreadAssociationSubmitted, true);
  document.addEventListener("keydown", markPendingThreadAssociationSubmitted, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
