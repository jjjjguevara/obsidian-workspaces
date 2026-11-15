import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  captureMeasurementEnvironment,
  assertMeasurementEnvironment,
} = require('../obsidian/measurement-environment.cjs');

function fixture() {
  const document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    querySelector: () => null,
    defaultView: { electronWindow: { isFocused: () => true } },
  };
  const setting: any = {
    isOpen: false,
    popout: null,
    modalEl: { isConnected: false, ownerDocument: document },
    containerEl: { isConnected: false },
    isInPopoutWindow() {
      return this.popout !== null;
    },
    getPopoutWindow() {
      return this.popout?.win ?? null;
    },
  };
  return { document, app: { setting, workspace: { containerEl: { ownerDocument: document } } } };
}

test('inspected closed Settings and both focused document/window qualify without changing UI', () => {
  const { app } = fixture();
  const observed = captureMeasurementEnvironment(app, '1.15.1');
  assert.doesNotThrow(() => assertMeasurementEnvironment(observed));
  assert.equal(app.setting.isOpen, false);
  assert.equal(app.setting.popout, null);
  assert.equal(observed.nativeSettingsObservation.supported, true);
});

test('separate Settings window rejects even when legacy main-document checks are false', () => {
  const { app } = fixture();
  app.setting.isOpen = true;
  app.setting.popout = { win: { closed: false } };
  app.setting.modalEl = { isConnected: true, ownerDocument: {} };
  const observed = captureMeasurementEnvironment(app, '1.15.1');
  assert.equal(observed.settingsContainerConnected, false);
  assert.equal(observed.nativeSettingsPresent, false);
  assert.equal(observed.nativeSettingsObservation.modalInMainDocument, false);
  assert.equal(observed.nativeSettingsObservation.livePopoutWindow, true);
  assert.throws(() => assertMeasurementEnvironment(observed), /fully closed/);
});

test('closed flag cannot hide a retained popout or connected native Settings modal', () => {
  for (const mutate of [
    (setting: any) => {
      setting.popout = { win: { closed: true } };
    },
    (setting: any) => {
      setting.modalEl.isConnected = true;
    },
  ]) {
    const { app } = fixture();
    mutate(app.setting);
    assert.throws(
      () => assertMeasurementEnvironment(captureMeasurementEnvironment(app, '1.15.1')),
      /fully closed/,
    );
  }
});

test('unsupported Settings shape/version refuses timing with observable failure details', () => {
  for (const version of ['1.15.1', '1.15.2']) {
    const { app } = fixture();
    if (version === '1.15.1') delete app.setting.getPopoutWindow;
    const observed = captureMeasurementEnvironment(app, version);
    assert.equal(observed.nativeSettingsObservation.supported, false);
    assert.equal(typeof observed.nativeSettingsObservation.error, 'string');
    assert.throws(() => assertMeasurementEnvironment(observed), /unsupported/);
  }
});

test('unfocused or unsupported native window cannot be masked by document.hasFocus', () => {
  for (const focus of [() => false, undefined, () => Promise.resolve(true)]) {
    const { app, document } = fixture();
    (document.defaultView.electronWindow as any).isFocused = focus;
    const observed = captureMeasurementEnvironment(app, '1.15.1');
    assert.equal(observed.documentHasFocus, true);
    assert.throws(() => assertMeasurementEnvironment(observed), /unfocused or unsupported/);
  }
});

test('a false document focus flag refuses the first sample immediately', () => {
  const { app, document } = fixture();
  document.hasFocus = () => false;
  assert.throws(
    () => assertMeasurementEnvironment(captureMeasurementEnvironment(app, '1.15.1')),
    /focused workspace document/,
  );
});
