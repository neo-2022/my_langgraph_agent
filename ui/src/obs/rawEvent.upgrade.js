export const RAW_EVENT_SCHEMA_VERSION = "REGART.Art.RawEvent.v1";

const toSafeEvent = (event) => ({ ...(event || {}) });

const upgradeHandlers = {
  [RAW_EVENT_SCHEMA_VERSION]: (event) => ({ ...event }),
};

const downgradeHandlers = {
  [RAW_EVENT_SCHEMA_VERSION]: (event) => ({ ...event }),
};

function mergeVersionHistory(existing = [], additions = []) {
  const history = Array.isArray(existing) ? [...existing] : [];
  for (const value of additions) {
    if (!value) continue;
    const text = value?.toString?.().trim();
    if (!text || history.includes(text)) continue;
    history.push(text);
  }
  return history;
}

export function upgradeRawEventSchema(event, targetVersion = RAW_EVENT_SCHEMA_VERSION) {
  const base = toSafeEvent(event);
  const currentVersion = base.schema_version?.toString?.() || RAW_EVENT_SCHEMA_VERSION;
  const handler = upgradeHandlers[currentVersion] ?? upgradeHandlers[RAW_EVENT_SCHEMA_VERSION];
  const upgraded = handler(base);
  upgraded.schema_version = targetVersion;
  upgraded.version_history = mergeVersionHistory(
    upgraded.version_history,
    [currentVersion, targetVersion],
  );
  return upgraded;
}

export function downgradeRawEventSchema(event, targetVersion) {
  if (!targetVersion || targetVersion === RAW_EVENT_SCHEMA_VERSION) {
    return { ...event, schema_version: targetVersion || RAW_EVENT_SCHEMA_VERSION };
  }
  const handler = downgradeHandlers[targetVersion];
  if (handler) {
    const downgraded = handler(toSafeEvent(event));
    downgraded.schema_version = targetVersion;
    downgraded.version_history = mergeVersionHistory(
      downgraded.version_history,
      [targetVersion],
    );
    return downgraded;
  }
  return { ...event, schema_version: targetVersion };
}
