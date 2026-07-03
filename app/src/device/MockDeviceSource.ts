import { Camera } from 'react-native-vision-camera';
import { SEGMENT_SECONDS } from '../config';
import type { Segment } from '../types';
import type { DeviceVideoSource } from './DeviceVideoSource';

/**
 * Mock Device Kit: the phone's own camera stands in for the glasses feed so
 * the entire capture loop is testable with zero glasses hardware. Records
 * fixed-length segments back-to-back via react-native-vision-camera.
 *
 * The Armed screen renders the <Camera> view and hands us its ref via
 * `attachCamera` before `start()` is called.
 */
export class MockDeviceSource implements DeviceVideoSource {
  readonly kind = 'mock' as const;

  private camera: Camera | null = null;
  private running = false;
  private recording = false;
  private segmentTimer: ReturnType<typeof setTimeout> | null = null;
  private segmentStartedAt = 0;
  private cutWaiters: Array<() => void> = [];
  private onSegment: ((segment: Segment) => void) | null = null;
  private onError: ((e: Error) => void) | null = null;

  attachCamera(camera: Camera | null): void {
    this.camera = camera;
  }

  async prepare(): Promise<void> {
    const cam = await Camera.requestCameraPermission();
    const mic = await Camera.requestMicrophonePermission();
    if (cam !== 'granted' || mic !== 'granted') {
      throw new Error('Camera and microphone permissions are required to buffer video.');
    }
  }

  async start(
    onSegment: (segment: Segment) => void,
    onError: (e: Error) => void,
  ): Promise<void> {
    if (!this.camera) {
      throw new Error('MockDeviceSource: no camera attached — is the viewfinder mounted?');
    }
    this.onSegment = onSegment;
    this.onError = onError;
    this.running = true;
    this.beginSegment();
  }

  async cut(): Promise<void> {
    if (!this.recording) {
      return;
    }
    const delivered = new Promise<void>(resolve => this.cutWaiters.push(resolve));
    this.clearTimer();
    await this.camera?.stopRecording();
    await delivered;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearTimer();
    if (this.recording) {
      try {
        await this.camera?.stopRecording();
      } catch {
        // session already torn down
      }
    }
    this.onSegment = null;
    this.onError = null;
  }

  private beginSegment(): void {
    const camera = this.camera;
    if (!camera || !this.running) {
      return;
    }
    this.segmentStartedAt = Date.now();
    this.recording = true;
    camera.startRecording({
      fileType: 'mp4',
      onRecordingFinished: video => {
        this.recording = false;
        this.onSegment?.({
          path: normalizePath(video.path),
          startedAt: this.segmentStartedAt,
          durationSec: video.duration,
        });
        this.releaseCutWaiters();
        if (this.running) {
          this.beginSegment();
        }
      },
      onRecordingError: error => {
        this.recording = false;
        this.releaseCutWaiters();
        if (this.running) {
          this.onError?.(new Error(`Recording failed: ${error.message}`));
        }
      },
    });
    this.segmentTimer = setTimeout(() => {
      camera.stopRecording().catch(() => {
        // stop raced with an error/teardown; onRecordingError handles it
      });
    }, SEGMENT_SECONDS * 1000);
  }

  private clearTimer(): void {
    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }
  }

  private releaseCutWaiters(): void {
    const waiters = this.cutWaiters;
    this.cutWaiters = [];
    waiters.forEach(resolve => resolve());
  }
}

function normalizePath(path: string): string {
  return path.startsWith('file://') ? path.slice('file://'.length) : path;
}
