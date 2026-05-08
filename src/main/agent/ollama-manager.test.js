jest.mock('electron', () => {
  const handlers = new Map();
  return {
    ipcMain: {
      handle: jest.fn((channel, handler) => handlers.set(channel, handler)),
      _handlers: handlers,
    },
    app: {
      isPackaged: false,
      getPath: jest.fn(() => '/tmp/cache'),
    },
    BrowserWindow: {
      getAllWindows: jest.fn(() => []),
    },
  };
});

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
}));

const mockHttpGet = jest.fn();
jest.mock('http', () => ({
  get: (...args) => mockHttpGet(...args),
}));

const mockSocketInstance = jest.fn();
jest.mock('net', () => ({
  Socket: jest.fn(() => mockSocketInstance()),
}));

const { ipcMain } = require('electron');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const {
  registerOllamaIpc,
  startOllama,
  stopOllama,
  getActivePort,
  _internals,
} = require('./ollama-manager');

function makeOpenSocket() {
  return {
    setTimeout: jest.fn(),
    on: jest.fn((event, handler) => {
      if (event === 'connect') setImmediate(handler);
    }),
    destroy: jest.fn(),
    connect: jest.fn(),
  };
}

function makeClosedSocket() {
  return {
    setTimeout: jest.fn(),
    on: jest.fn((event, handler) => {
      if (event === 'error') setImmediate(handler);
    }),
    destroy: jest.fn(),
    connect: jest.fn(),
  };
}

function mockHealthOk(version = '0.23.2') {
  mockHttpGet.mockImplementation((_url, _opts, cb) => {
    const dataHandlers = [];
    const endHandlers = [];
    const res = {
      statusCode: 200,
      on: jest.fn((event, handler) => {
        if (event === 'data') dataHandlers.push(handler);
        if (event === 'end') endHandlers.push(handler);
      }),
      resume: jest.fn(),
    };
    setImmediate(() => {
      cb(res);
      for (const h of dataHandlers) h(JSON.stringify({ version }));
      for (const h of endHandlers) h();
    });
    return { on: jest.fn(), end: jest.fn(), destroy: jest.fn() };
  });
}

function mockHealthFail() {
  mockHttpGet.mockImplementation((_url, _opts, _cb) => {
    const errHandlers = [];
    const req = {
      on: jest.fn((event, handler) => {
        if (event === 'error') errHandlers.push(handler);
      }),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    setImmediate(() => {
      for (const h of errHandlers) h();
    });
    return req;
  });
}

beforeEach(() => {
  ipcMain.handle.mockClear();
  ipcMain._handlers.clear();
  mockHttpGet.mockReset();
  mockSocketInstance.mockReset();
  fs.existsSync.mockReturnValue(true);
  _internals.reset();
});

describe('registerOllamaIpc', () => {
  test('registers all four IPC channels', () => {
    registerOllamaIpc();
    expect([...ipcMain._handlers.keys()].sort()).toEqual(
      [IPC.OLLAMA_START, IPC.OLLAMA_STOP, IPC.OLLAMA_GET_STATUS, IPC.OLLAMA_CHECK_BINARY].sort()
    );
  });

  test('OLLAMA_GET_STATUS reports stopped + null error initially', async () => {
    registerOllamaIpc();
    const handler = ipcMain._handlers.get(IPC.OLLAMA_GET_STATUS);
    expect(handler()).toEqual({ status: 'stopped', error: null });
  });

  test('OLLAMA_CHECK_BINARY reports availability based on fs.existsSync', () => {
    registerOllamaIpc();
    const handler = ipcMain._handlers.get(IPC.OLLAMA_CHECK_BINARY);
    expect(handler()).toEqual({ available: true });
    fs.existsSync.mockReturnValue(false);
    expect(handler()).toEqual({ available: false });
  });
});

describe('detectExistingDaemon', () => {
  test('returns found:true when default port responds with valid version', async () => {
    mockSocketInstance.mockReturnValue(makeOpenSocket());
    mockHealthOk('0.23.2');
    const result = await _internals.detectExistingDaemon();
    expect(result).toEqual({ found: true, port: 11434, version: '0.23.2' });
  });

  test('returns found:false when default port is closed', async () => {
    mockSocketInstance.mockReturnValue(makeClosedSocket());
    const result = await _internals.detectExistingDaemon();
    expect(result).toEqual({ found: false });
  });

  test('returns conflict:true when port is busy but probe fails', async () => {
    mockSocketInstance.mockReturnValue(makeOpenSocket());
    mockHealthFail();
    const result = await _internals.detectExistingDaemon();
    expect(result).toEqual({ found: false, conflict: true, port: 11434 });
  });
});

describe('startOllama (reuse path)', () => {
  test('reuses existing daemon when one is found on default port', async () => {
    mockSocketInstance.mockReturnValue(makeOpenSocket());
    mockHealthOk();
    const childProcess = require('child_process');
    await startOllama();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(getActivePort()).toBe(11434);
  });

  test('returns immediately when already running', async () => {
    mockSocketInstance.mockReturnValue(makeOpenSocket());
    mockHealthOk();
    await startOllama();
    mockSocketInstance.mockClear();
    await startOllama();
    expect(mockSocketInstance).not.toHaveBeenCalled();
  });
});

describe('stopOllama', () => {
  test('clears reused-mode state without sending SIGTERM (no spawned process)', async () => {
    mockSocketInstance.mockReturnValue(makeOpenSocket());
    mockHealthOk();
    await startOllama();
    await stopOllama();
    const childProcess = require('child_process');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('resolves immediately when no process and no reused daemon', async () => {
    await expect(stopOllama()).resolves.toBeUndefined();
  });
});
