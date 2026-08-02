#import <React/RCTBridgeModule.h>

/**
 * ObjC registration for the Swift LiveActivityBridge. In the app target rather
 * than a pod, for the same reason as MWDATBridge: it shares
 * ClipsoActivityAttributes.swift with the ClipsoWidgets extension, and that
 * type is only visible to app-target sources.
 */
@interface RCT_EXTERN_MODULE (LiveActivityBridge, NSObject)

RCT_EXTERN_METHOD(isSupported:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(start:(NSString *)deviceName
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(update:(nonnull NSNumber *)bufferedSeconds
                  clipCount:(nonnull NSNumber *)clipCount
                  recording:(nonnull NSNumber *)recording
                  recordingSince:(nonnull NSNumber *)recordingSince
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(end:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
