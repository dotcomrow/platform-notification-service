export type BrowserPushDeviceTarget = "current_device" | "favorite_device" | "all_devices";

export type BrowserPushRoutingCandidate = {
  browser_installation_id?: string | null;
  browser_push_device_target?: BrowserPushDeviceTarget | string | null;
  is_preferred?: boolean | null;
  is_notification_target?: boolean | null;
};

export type BrowserPushRoutingPersistencePatch = {
  browser_push_device_target: BrowserPushDeviceTarget;
  is_notification_target: boolean;
};

export function normalizeBrowserPushOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function resolveBrowserPushAllowedOrigins(
  appUrls: unknown[],
  requestUrls: unknown[],
): string[] {
  const appOrigins = [...new Set(appUrls.map(normalizeBrowserPushOrigin).filter(Boolean))];
  if (appOrigins.length > 0) return appOrigins;
  return [...new Set(requestUrls.map(normalizeBrowserPushOrigin).filter(Boolean))];
}

export function browserPushOriginAllowed(candidateOrigin: unknown, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  const normalizedCandidateOrigin = normalizeBrowserPushOrigin(candidateOrigin);
  return Boolean(normalizedCandidateOrigin && allowedOrigins.includes(normalizedCandidateOrigin));
}

export function browserPushAppAllowed(
  candidateAppId: unknown,
  expectedAppId: unknown,
  candidateOrigin: unknown,
  allowedOrigins: string[],
): boolean {
  const normalizedCandidateAppId = typeof candidateAppId === "string" ? candidateAppId.trim() : "";
  const normalizedExpectedAppId = typeof expectedAppId === "string" ? expectedAppId.trim() : "";
  if (normalizedExpectedAppId && normalizedCandidateAppId) {
    return normalizedCandidateAppId === normalizedExpectedAppId;
  }
  return browserPushOriginAllowed(candidateOrigin, allowedOrigins);
}

export function normalizeBrowserPushDeviceTarget(value: unknown): BrowserPushDeviceTarget | null {
  return value === "current_device" || value === "favorite_device" || value === "all_devices"
    ? value
    : null;
}

export function persistedBrowserPushDeviceTarget(
  candidates: BrowserPushRoutingCandidate[]
): BrowserPushDeviceTarget | null {
  for (const candidate of candidates) {
    const target = normalizeBrowserPushDeviceTarget(candidate.browser_push_device_target);
    if (target) {
      return target;
    }
  }
  return null;
}

export function inheritedBrowserPushRoutingPatch(
  target: BrowserPushDeviceTarget | null,
  wasNotificationTarget = false,
): BrowserPushRoutingPersistencePatch | Record<string, never> {
  if (!target) {
    return {};
  }
  return {
    browser_push_device_target: target,
    is_notification_target: target === "all_devices" || wasNotificationTarget,
  };
}

export function selectBrowserPushCandidates<T extends BrowserPushRoutingCandidate>(
  candidates: T[],
  target: BrowserPushDeviceTarget,
  browserInstallationId = ""
): T[] {
  if (target === "all_devices") {
    return [...candidates];
  }
  if (target === "favorite_device") {
    const favorite = candidates.find((candidate) => candidate.is_preferred === true);
    return favorite ? [favorite] : [];
  }
  const current = candidates.find((candidate) =>
    Boolean(browserInstallationId) && candidate.browser_installation_id === browserInstallationId
  );
  return current ? [current] : [];
}
