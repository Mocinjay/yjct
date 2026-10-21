import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

const mockNative = {
  requestPermission: jest.fn(async () => true),
  transcribeFile: jest.fn(async () => ({
    transcript: 'that was sick clypso',
    words: [
      { text: 'that', end: 0.4 },
      { text: 'was', end: 0.7 },
      { text: 'sick', end: 1.1 },
      { text: 'clypso', end: 1.8 },
    ],
  })),
  startListening: jest.fn(async () => true),
  stopListening: jest.fn(async () => true),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
// NativeEventEmitter reads the module off NativeModules when start() runs.
NativeModules.SpeechWakeWord = mockNative;
jest.mock('../src/native/SpeechWakeWordNative', () => ({
  ...jest.requireActual('../src/native/SpeechWakeWordNative'),
  SpeechWakeWordNative: {
    requestPermission: () => mockNative.requestPermission(),
    transcribeFile: () => mockNative.transcribeFile(),
    startListening: () => mockNative.startListening(),
    stopListening: () => mockNative.stopListening(),
  },
}));

import { SpeechWakeWord } from '../src/wakeword/SpeechWakeWord';
import type { WakeDetection } from '../src/wakeword/WakeWordProvider';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('SpeechWakeWord on its own microphone (iOS)', () => {
  beforeAll(() => {
    Platform.OS = 'ios';
  });
  beforeEach(() => jest.clearAllMocks());

  it('places the phrase on the wall clock from the segment it was heard in', async () => {
    const wake = new SpeechWakeWord({ ownMicrophone: true });
    const heard: Array<WakeDetection | undefined> = [];
    await wake.start(d => heard.push(d));
    expect(mockNative.startListening).toHaveBeenCalled();

    DeviceEventEmitter.emit('SpeechWakeWordSegment', {
      path: '/caches/wake-1.m4a',
      startedAtMs: 1_000_000,
      durationSec: 5,
      peak: 0.3,
    });
    await settle();

    expect(heard).toEqual([
      { segmentPath: '/caches/wake-1.m4a', endOffsetSec: 1.8, atMs: 1_001_800 },
    ]);
    await wake.stop();
    expect(mockNative.stopListening).toHaveBeenCalled();
  });

  it('passes on listening that stopped on its own', async () => {
    const errors: string[] = [];
    const wake = new SpeechWakeWord({ ownMicrophone: true, onListeningError: m => errors.push(m) });
    await wake.start(() => {});
    DeviceEventEmitter.emit('SpeechWakeWordError', { message: 'Listening kept failing' });
    expect(errors).toEqual(['Listening kept failing']);
    await wake.stop();
  });

  it('leaves the microphone alone when fed segments (live mode)', async () => {
    const wake = new SpeechWakeWord();
    await wake.start(() => {});
    await wake.stop();
    expect(mockNative.startListening).not.toHaveBeenCalled();
    expect(mockNative.stopListening).not.toHaveBeenCalled();
  });
});
