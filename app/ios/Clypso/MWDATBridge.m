#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

/**
 * ObjC registration for the Swift MWDATBridge (Meta Wearables Device Access
 * Toolkit). Lives in the app target — unlike modules/clip-stitcher — because
 * the MWDAT frameworks arrive via Swift Package Manager on the app target and
 * are not visible to CocoaPods pod targets.
 */
@interface RCT_EXTERN_MODULE (MWDATBridge, RCTEventEmitter)

RCT_EXTERN_METHOD(getRegistrationState:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(startRegistration:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(prepare:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getDiagnostics:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
// Temporary instrument: proves whether the live stream survives a native
// glasses recording. Remove with the concurrency probe once answered.
RCT_EXTERN_METHOD(getStreamTimeline:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(mockEnable:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(startPreview:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopPreview:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setPreviewEnabled:(nonnull NSNumber *)enabled
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(start:(nonnull NSNumber *)segmentSeconds
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(cut:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopRecording:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(chime:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
// Fire-and-forget by design: a logging call that returns a promise would put a
// bridge round-trip on every log line, and a rejected one would need logging.
RCT_EXTERN_METHOD(writeDiagnostic:(nonnull NSString *)line)

@end
