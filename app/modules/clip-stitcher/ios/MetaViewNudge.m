#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <UIKit/UIKit.h>

/**
 * Opt-in probe: open Meta View / Meta AI via documented URL schemes after a
 * mark, to test whether foregrounding the companion shortens glasses→Photos
 * sync. Not a sync API — see docs/LATERAL-WORKAROUNDS.md.
 */
@interface MetaViewNudge : NSObject <RCTBridgeModule>
@end

@implementation MetaViewNudge

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

/// Schemes to try. `fb-viewapp` is the DAT-documented companion scheme.
static NSArray<NSString *> *MVNCandidateURLs(void)
{
  return @[
    @"fb-viewapp://",
    @"fb-viewapp-deeplink://",
    @"meta-view://",
    @"metaview://",
  ];
}

RCT_EXPORT_METHOD(probeSchemes:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSMutableArray *rows = [NSMutableArray array];
  for (NSString *raw in MVNCandidateURLs()) {
    NSURL *url = [NSURL URLWithString:raw];
    BOOL can = url != nil && [[UIApplication sharedApplication] canOpenURL:url];
    [rows addObject:@{ @"url" : raw, @"canOpen" : @(can) }];
  }
  resolve(rows);
}

/**
 * Opens the first scheme `canOpenURL` accepts. Call only when the wearer
 * opts in — auto-firing on every mark is a bad live UX and looks spammy.
 */
RCT_EXPORT_METHOD(openCompanion:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    UIApplication *app = [UIApplication sharedApplication];
    for (NSString *raw in MVNCandidateURLs()) {
      NSURL *url = [NSURL URLWithString:raw];
      if (url == nil || ![app canOpenURL:url]) {
        continue;
      }
      [app openURL:url
           options:@{}
 completionHandler:^(BOOL success) {
        if (success) {
          resolve(@{ @"opened" : raw, @"ok" : @YES });
        } else {
          resolve(@{ @"opened" : raw, @"ok" : @NO });
        }
      }];
      return;
    }
    resolve(@{
      @"opened" : [NSNull null],
      @"ok" : @NO,
      @"reason" : @"no-candidate-scheme-available",
    });
  });
}

@end
