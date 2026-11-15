/* Read-only, version-pinned native timing preconditions. Never closes/focuses UI. */
const SETTINGS_SCHEMA = 'obsidian-workspaces-native-settings-observation-v1';
const FOCUS_SCHEMA = 'obsidian-workspaces-native-focus-observation-v1';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function observeSettings(setting, mainDocument, apiVersion) {
  const observation = { schema: SETTINGS_SCHEMA, apiVersion, supported: false };
  try {
    assert(
      apiVersion === '1.15.1',
      'Settings observation supports inspected Obsidian 1.15.1 only.',
    );
    assert(
      setting &&
        typeof setting.isOpen === 'boolean' &&
        typeof setting.isInPopoutWindow === 'function' &&
        typeof setting.getPopoutWindow === 'function' &&
        'popout' in setting &&
        typeof setting.modalEl?.isConnected === 'boolean' &&
        setting.modalEl.ownerDocument,
      'Native Settings lifecycle capabilities are unavailable.',
    );
    const inPopoutWindow = setting.isInPopoutWindow();
    const popoutWindow = setting.getPopoutWindow();
    assert(typeof inPopoutWindow === 'boolean', 'Unexpected Settings popout predicate.');
    assert(
      popoutWindow === null || (popoutWindow && typeof popoutWindow.closed === 'boolean'),
      'Unexpected native Settings popout window.',
    );
    Object.assign(observation, {
      supported: true,
      isOpen: setting.isOpen,
      inPopoutWindow,
      popoutReferencePresent: setting.popout !== null,
      popoutWindowPresent: popoutWindow !== null,
      livePopoutWindow: popoutWindow !== null && !popoutWindow.closed,
      modalConnected: setting.modalEl.isConnected,
      modalInMainDocument: setting.modalEl.ownerDocument === mainDocument,
    });
  } catch (error) {
    observation.error = error.message ?? String(error);
  }
  return observation;
}

function captureMeasurementEnvironment(app, apiVersion) {
  const document = app.workspace.containerEl.ownerDocument;
  const nativeWindowFocus = { schema: FOCUS_SCHEMA, supported: false };
  try {
    const window = document.defaultView?.electronWindow;
    assert(
      apiVersion === '1.15.1' && typeof window?.isFocused === 'function',
      'Native window focus capability is unavailable.',
    );
    const focused = window.isFocused();
    assert(typeof focused === 'boolean', 'Native window focus did not return a boolean.');
    Object.assign(nativeWindowFocus, { supported: true, focused });
  } catch (error) {
    nativeWindowFocus.error = error.message ?? String(error);
  }
  return {
    documentVisibility: document.visibilityState,
    documentHasFocus: document.hasFocus(),
    nativeWindowFocus,
    nativeSettingsObservation: observeSettings(app.setting, document, apiVersion),
    // Supplementary legacy fields. Main-document selectors alone cannot see
    // Settings when its actual modalEl lives in a separate native popout.
    settingsContainerConnected: !!app.setting?.containerEl?.isConnected,
    nativeSettingsPresent: !!document.querySelector(
      '.modal.mod-settings, .mod-settings .vertical-tab-container',
    ),
  };
}

function assertMeasurementEnvironment(observation) {
  assert(
    observation.documentVisibility === 'visible' && observation.documentHasFocus === true,
    'Benchmark requires the visible, focused workspace document before timing.',
  );
  const focus = observation.nativeWindowFocus;
  assert(
    focus?.schema === FOCUS_SCHEMA && focus.supported === true && focus.focused === true,
    `Native workspace window is unfocused or unsupported: ${JSON.stringify(focus)}.`,
  );
  const settings = observation.nativeSettingsObservation;
  assert(
    settings?.schema === SETTINGS_SCHEMA &&
      settings.apiVersion === '1.15.1' &&
      settings.supported === true,
    `Native Settings observation is unsupported: ${JSON.stringify(settings)}.`,
  );
  assert(
    [
      'isOpen',
      'inPopoutWindow',
      'popoutReferencePresent',
      'popoutWindowPresent',
      'livePopoutWindow',
      'modalConnected',
    ].every((field) => settings[field] === false) &&
      observation.settingsContainerConnected === false &&
      observation.nativeSettingsPresent === false,
    'Settings must be fully closed, including its separate native window, before timing.',
  );
}

module.exports = {
  SETTINGS_SCHEMA,
  FOCUS_SCHEMA,
  observeSettings,
  captureMeasurementEnvironment,
  assertMeasurementEnvironment,
};
