describe('profile-registry-watcher', () => {
  let fs;
  let watchProfileRegistry;
  let stopWatchingProfileRegistry;
  let watchCallback;
  let mockWatcher;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.doMock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    fs = require('fs');
    mockWatcher = { close: jest.fn(), on: jest.fn() };
    jest.spyOn(fs, 'watch').mockImplementation((_dir, cb) => {
      watchCallback = cb;
      return mockWatcher;
    });
    ({ watchProfileRegistry, stopWatchingProfileRegistry } = require('./profile-registry-watcher'));
  });

  afterEach(() => {
    stopWatchingProfileRegistry();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('watches the app root directory (survives atomic rename)', () => {
    watchProfileRegistry('/app/root', () => {});
    expect(fs.watch).toHaveBeenCalledWith('/app/root', expect.any(Function));
  });

  test('debounces and fires onChange once for registry-file changes', () => {
    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange);

    watchCallback('rename', 'profile-registry.json');
    watchCallback('change', 'profile-registry.json');
    expect(onChange).not.toHaveBeenCalled();

    jest.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('ignores the atomic-write temp file and unrelated files', () => {
    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange);

    watchCallback('rename', 'profile-registry.json.4321.tmp');
    watchCallback('change', 'something-else.json');

    jest.advanceTimersByTime(200);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('reacts when the platform omits the filename', () => {
    const onChange = jest.fn();
    watchProfileRegistry('/app/root', onChange);

    watchCallback('change', null);
    jest.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('no-ops without an appRoot or callback', () => {
    expect(typeof watchProfileRegistry()).toBe('function');
    expect(fs.watch).not.toHaveBeenCalled();
  });

  test('stop closes the underlying watcher', () => {
    watchProfileRegistry('/app/root', () => {});
    stopWatchingProfileRegistry();
    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
