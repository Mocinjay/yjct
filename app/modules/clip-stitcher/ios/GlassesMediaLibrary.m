#import <AVFoundation/AVFoundation.h>
#import <Photos/Photos.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <fcntl.h>
#import <unistd.h>

/**
 * Finds recordings the glasses made on their own and hands them over intact.
 *
 * The toolkit's camera stream is capped at 720x1280 over Bluetooth, with
 * per-frame compression that adapts to whatever bandwidth is left. What the
 * glasses write to their own storage is a different thing entirely — measured
 * against the same scene, 1520x2032 at 30fps in HEVC with HLG colour, roughly
 * three and a half times the pixels and none of the link's compression. There
 * is no API that reaches that file: it belongs to Meta AI, which syncs it to
 * the phone's library like any other camera would.
 *
 * So this module does not ask the toolkit for anything. It watches the photo
 * library, recognizes what came off the glasses, and copies the original bytes.
 */

static void GMLDiag(NSString *message)
{
  static NSString *path;
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                                NSUserDomainMask, YES).firstObject
        stringByAppendingPathComponent:@"clypso-diagnostics.log"];
    queue = dispatch_queue_create("com.mocinjay.clypso.gmldiag",
                                  DISPATCH_QUEUE_SERIAL);
  });
  if (path == nil) {
    return;
  }
  NSString *line = [NSString
      stringWithFormat:@"%@ [GlassesMediaLibrary] %@\n",
                       [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
                       message];
  dispatch_async(queue, ^{
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    int fd = open(path.fileSystemRepresentation, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (fd < 0) {
      return;
    }
    write(fd, data.bytes, data.length);
    close(fd);
  });
}

// ASCII-only, for the same reason as the rest of the module: a non-ASCII
// format string is invisible to `strings` on an installed build.
#define GMLLog(fmt, ...)                                                       \
  do {                                                                         \
    NSLog(@"[GlassesMediaLibrary] %s:%d %s: " fmt,                             \
          [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,    \
          ##__VA_ARGS__);                                                      \
    GMLDiag([NSString stringWithFormat:fmt, ##__VA_ARGS__]);                   \
  } while (0)

/// Emitted when the library gains assets, so JS can rescan.
static NSString *const GMLLibraryChangedEvent = @"GlassesMediaLibraryChanged";

/**
 * Substring that marks an asset as ours.
 *
 * Verified against a real recording: AVFoundation surfaces
 * `com.apple.quicktime.model` under the common `model` key with the value
 * "Ray-Ban Meta Smart Glasses". Matching a substring rather than the whole
 * string keeps the Oakley and Display models — which carry their own product
 * names — from needing a new entry each time.
 */
static NSString *const GMLGlassesModelMarker = @"Meta";
/// Second opinion: every file Meta AI writes carries this copyright.
static NSString *const GMLGlassesCopyright = @"Meta AI";

@interface GlassesMediaLibrary : RCTEventEmitter <RCTBridgeModule, PHPhotoLibraryChangeObserver>
@property (nonatomic, assign) BOOL hasListeners;
@property (nonatomic, assign) BOOL watching;
/// localIdentifier -> @(BOOL). Deciding whether an asset came off the glasses
/// means opening it; a day of rescans should only pay that once per asset.
@property (nonatomic, strong) NSCache<NSString *, NSNumber *> *verdicts;
@end

@implementation GlassesMediaLibrary

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  self = [super init];
  if (self != nil) {
    _verdicts = [[NSCache alloc] init];
    _verdicts.countLimit = 2000;
  }
  return self;
}

- (void)dealloc
{
  if (_watching) {
    [[PHPhotoLibrary sharedPhotoLibrary] unregisterChangeObserver:self];
  }
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ GMLLibraryChangedEvent ];
}

- (void)startObserving
{
  self.hasListeners = YES;
}

- (void)stopObserving
{
  self.hasListeners = NO;
}

#pragma mark - Access

static NSDictionary *GMLAccessPayload(PHAuthorizationStatus status)
{
  NSString *name;
  switch (status) {
    case PHAuthorizationStatusAuthorized: name = @"authorized"; break;
    case PHAuthorizationStatusLimited: name = @"limited"; break;
    case PHAuthorizationStatusDenied: name = @"denied"; break;
    case PHAuthorizationStatusRestricted: name = @"restricted"; break;
    default: name = @"undetermined"; break;
  }
  return @{
    @"status" : name,
    // "limited" means the wearer picked specific assets. Reads work, but a
    // glasses recording they did not hand-pick is invisible, which for this
    // feature is functionally the same as denied — say so rather than let it
    // look like the glasses never recorded anything.
    @"usable" : @(status == PHAuthorizationStatusAuthorized),
  };
}

/**
 * Ask for access to the library, prompting if the wearer has not been asked.
 *
 * `PHAccessLevelReadWrite` is the only level that grants reads at all —
 * `PHAccessLevelAddOnly` permits writing and nothing else — so it is what has
 * to be asked for even though nothing here ever writes.
 */
RCT_EXPORT_METHOD(requestAccess:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite
                                             handler:^(PHAuthorizationStatus status) {
    GMLLog(@"photo library access -> %@", GMLAccessPayload(status)[@"status"]);
    resolve(GMLAccessPayload(status));
  }];
}

/**
 * What access stands right now, without prompting.
 *
 * Separate from `requestAccess` because the interesting case is the wearer
 * revoking access in Settings long after granting it — iOS restarts the app,
 * but nothing tells the running code, so the only way to notice is to look
 * again. Looking must not be able to put a prompt on screen.
 */
RCT_EXPORT_METHOD(currentAccess:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve(GMLAccessPayload(
      [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite]));
}

#pragma mark - Recognition

/// Capture start, which is not the same as when the file appeared.
///
/// `com.apple.quicktime.creationdate` is written when the glasses begin
/// recording; the container's own modification time is set when Meta AI
/// finishes muxing and transferring it, measured at 56 seconds later on a
/// 17-second clip. Only the former can place a spoken marker inside the video.
static NSDate *GMLCaptureDate(AVAsset *asset, PHAsset *phAsset)
{
  for (AVMetadataItem *item in
       [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                               withKey:AVMetadataCommonKeyCreationDate
                              keySpace:AVMetadataKeySpaceCommon]) {
    if (item.dateValue != nil) {
      return item.dateValue;
    }
    NSString *text = item.stringValue;
    if (text.length == 0) {
      continue;
    }
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    NSDate *parsed = [formatter dateFromString:text];
    if (parsed == nil) {
      formatter.formatOptions =
          NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
      parsed = [formatter dateFromString:text];
    }
    if (parsed != nil) {
      return parsed;
    }
  }
  // Photos usually copies the same value onto the asset, so this is a
  // near-equivalent fallback rather than a guess.
  return phAsset.creationDate;
}

/// Did this come off a pair of Meta glasses?
static BOOL GMLIsGlassesAsset(AVAsset *asset)
{
  NSArray<AVMetadataItem *> *model =
      [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                     withKey:AVMetadataCommonKeyModel
                                    keySpace:AVMetadataKeySpaceCommon];
  for (AVMetadataItem *item in model) {
    NSString *value = item.stringValue;
    if ([value containsString:GMLGlassesModelMarker] &&
        [value containsString:@"Glasses"]) {
      return YES;
    }
  }
  NSArray<AVMetadataItem *> *copyright =
      [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                     withKey:AVMetadataCommonKeyCopyrights
                                    keySpace:AVMetadataKeySpaceCommon];
  for (AVMetadataItem *item in copyright) {
    if ([item.stringValue isEqualToString:GMLGlassesCopyright]) {
      return YES;
    }
  }
  return NO;
}

/**
 * Load an asset without reaching for the network.
 *
 * `networkAccessAllowed` stays NO on purpose: a scan runs unattended and often
 * on cellular, and silently pulling multi-megabyte originals out of iCloud is
 * not a thing to do on the wearer's behalf. Assets that are not local yet are
 * reported as pending rather than fetched.
 */
static AVAsset *GMLLoadLocalAsset(PHAsset *phAsset)
{
  PHVideoRequestOptions *options = [[PHVideoRequestOptions alloc] init];
  options.networkAccessAllowed = NO;
  options.deliveryMode = PHVideoRequestOptionsDeliveryModeHighQualityFormat;
  options.version = PHVideoRequestOptionsVersionOriginal;

  __block AVAsset *result = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [[PHImageManager defaultManager]
      requestAVAssetForVideo:phAsset
                     options:options
               resultHandler:^(AVAsset *avAsset, AVAudioMix *mix, NSDictionary *info) {
                 result = avAsset;
                 dispatch_semaphore_signal(done);
               }];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  return result;
}

#pragma mark - Scanning

/**
 * Every video in the library created at or after `sinceMs` — glasses or not.
 *
 * Deliberately cheap: everything here comes off the `PHAsset` itself, so
 * nothing is opened, decoded or downloaded. That matters because of the order
 * the caller works in. Deciding whether a recording came off the glasses means
 * opening it, and most of the library never will have; asking first which
 * videos could even contain a spoken marker throws nearly all of them out for
 * free. Footage nobody marked is then never examined at all, let alone copied.
 */
RCT_EXPORT_METHOD(listRecentVideos:(double)sinceMs
                  limit:(NSInteger)limit
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if ([PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite] !=
      PHAuthorizationStatusAuthorized) {
    reject(@"no_access", @"Photo library access has not been granted.", nil);
    return;
  }

  PHFetchOptions *options = [[PHFetchOptions alloc] init];
  options.sortDescriptors = @[ [NSSortDescriptor sortDescriptorWithKey:@"creationDate"
                                                            ascending:NO] ];
  // Widen the window by an hour: Photos stamps assets from the QuickTime
  // creation date, so a clip that synced late can still land with an earlier
  // date than the caller last saw. Cheap insurance against skipping one.
  NSDate *since = [NSDate dateWithTimeIntervalSince1970:(sinceMs / 1000.0) - 3600.0];
  options.predicate = [NSPredicate predicateWithFormat:@"mediaType == %d AND creationDate >= %@",
                                                       PHAssetMediaTypeVideo, since];
  if (limit > 0) {
    options.fetchLimit = limit;
  }

  PHFetchResult<PHAsset *> *assets = [PHAsset fetchAssetsWithOptions:options];
  NSMutableArray<NSDictionary *> *videos = [NSMutableArray array];
  for (PHAsset *phAsset in assets) {
    NSNumber *cached = [self.verdicts objectForKey:phAsset.localIdentifier];
    if (cached != nil && !cached.boolValue) {
      // Already examined once and found to be somebody else's video.
      continue;
    }
    NSDate *created = phAsset.creationDate;
    [videos addObject:@{
      @"localIdentifier" : phAsset.localIdentifier,
      // Photos copies this from the QuickTime creation date, which makes it a
      // good enough window for filtering. `confirmGlassesVideo` re-reads the
      // exact value before anything is actually cut.
      @"startedAtMs" : @(created != nil ? [created timeIntervalSince1970] * 1000.0 : 0),
      @"durationSec" : @(phAsset.duration),
      @"width" : @(phAsset.pixelWidth),
      @"height" : @(phAsset.pixelHeight),
    }];
  }

  GMLLog(@"listed %lu recent video(s)", (unsigned long)videos.count);
  resolve(@{ @"videos" : videos });
}

/**
 * Open one asset and decide whether the glasses recorded it.
 *
 * This is the expensive half, which is why the caller only reaches it for
 * videos a marker already points into. It also re-reads the capture time from
 * the container, because that is the number the cut depends on and the one
 * Photos is only approximately right about.
 */
RCT_EXPORT_METHOD(confirmGlassesVideo:(NSString *)localIdentifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  PHFetchResult<PHAsset *> *assets =
      [PHAsset fetchAssetsWithLocalIdentifiers:@[ localIdentifier ] options:nil];
  PHAsset *phAsset = assets.firstObject;
  if (phAsset == nil) {
    reject(@"not_found", @"That recording is no longer in the photo library.", nil);
    return;
  }

  AVAsset *avAsset = GMLLoadLocalAsset(phAsset);
  if (avAsset == nil) {
    // Still in iCloud. Not a verdict — caching it would leave the asset
    // invisible even after it lands.
    resolve(@{ @"isGlasses" : @NO, @"pendingDownload" : @YES });
    return;
  }

  NSNumber *cached = [self.verdicts objectForKey:localIdentifier];
  BOOL const isGlasses =
      cached != nil ? cached.boolValue : GMLIsGlassesAsset(avAsset);
  [self.verdicts setObject:@(isGlasses) forKey:localIdentifier];

  if (!isGlasses) {
    resolve(@{ @"isGlasses" : @NO, @"pendingDownload" : @NO });
    return;
  }

  NSDate *captured = GMLCaptureDate(avAsset, phAsset);
  resolve(@{
    @"isGlasses" : @YES,
    @"pendingDownload" : @NO,
    @"startedAtMs" : @([captured timeIntervalSince1970] * 1000.0),
    @"durationSec" : @(CMTimeGetSeconds(avAsset.duration)),
    @"width" : @(phAsset.pixelWidth),
    @"height" : @(phAsset.pixelHeight),
  });
}

#pragma mark - Export

/**
 * Copy an asset's original bytes into the app's storage.
 *
 * `PHAssetResourceManager` is what makes this worth doing at all: it writes the
 * file as the glasses recorded it. An `AVAssetExportSession` would re-encode,
 * and re-encoding is precisely what this whole path exists to avoid — it would
 * flatten the HLG colour and spend a generation of quality to arrive at a file
 * no better than the stream we already rejected.
 */
RCT_EXPORT_METHOD(exportOriginal:(NSString *)localIdentifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  PHFetchResult<PHAsset *> *assets =
      [PHAsset fetchAssetsWithLocalIdentifiers:@[ localIdentifier ] options:nil];
  PHAsset *phAsset = assets.firstObject;
  if (phAsset == nil) {
    reject(@"not_found", @"That recording is no longer in the photo library.", nil);
    return;
  }

  PHAssetResource *video = nil;
  for (PHAssetResource *resource in [PHAssetResource assetResourcesForAsset:phAsset]) {
    if (resource.type == PHAssetResourceTypeVideo ||
        resource.type == PHAssetResourceTypeFullSizeVideo) {
      video = resource;
      if (resource.type == PHAssetResourceTypeFullSizeVideo) {
        break;
      }
    }
  }
  if (video == nil) {
    reject(@"no_resource", @"That recording has no video data.", nil);
    return;
  }

  NSString *directory = [NSSearchPathForDirectoriesInDomains(
                             NSDocumentDirectory, NSUserDomainMask, YES).firstObject
      stringByAppendingPathComponent:@"glasses-imports"];
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:NULL];
  NSString *extension = video.originalFilename.pathExtension.length > 0
                            ? video.originalFilename.pathExtension
                            : @"mov";
  NSString *name = [NSString stringWithFormat:@"glasses-%@.%@",
                                              @(labs((long)[localIdentifier hash])), extension];
  NSString *path = [directory stringByAppendingPathComponent:name];
  [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];

  PHAssetResourceRequestOptions *options = [[PHAssetResourceRequestOptions alloc] init];
  // Unlike the scan, this one is allowed to reach iCloud: the wearer has asked
  // for this specific recording by now, so the download is the thing they want.
  options.networkAccessAllowed = YES;

  [[PHAssetResourceManager defaultManager]
      writeDataForAssetResource:video
                         toFile:[NSURL fileURLWithPath:path]
                        options:options
              completionHandler:^(NSError *error) {
                if (error != nil) {
                  GMLLog(@"export FAILED for %@ - %@ [%@ %ld]", localIdentifier,
                         error.localizedDescription, error.domain, (long)error.code);
                  reject(@"export_failed", error.localizedDescription, error);
                  return;
                }
                unsigned long long const bytes =
                    [[[NSFileManager defaultManager] attributesOfItemAtPath:path
                                                                     error:NULL]
                        fileSize];
                GMLLog(@"exported %@ -> %@ (%llu bytes)", localIdentifier,
                       path.lastPathComponent, bytes);
                resolve(@{ @"path" : path, @"bytes" : @(bytes) });
              }];
}

#pragma mark - Watching

RCT_EXPORT_METHOD(startWatching:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!self.watching) {
    [[PHPhotoLibrary sharedPhotoLibrary] registerChangeObserver:self];
    self.watching = YES;
    GMLLog(@"watching the photo library");
  }
  resolve(@YES);
}

RCT_EXPORT_METHOD(stopWatching:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (self.watching) {
    [[PHPhotoLibrary sharedPhotoLibrary] unregisterChangeObserver:self];
    self.watching = NO;
    GMLLog(@"stopped watching the photo library");
  }
  resolve(@YES);
}

/**
 * Something changed in the library.
 *
 * Deliberately a nudge and not a payload: this fires for edits, favourites and
 * deletions as readily as for a new recording, and the change details describe
 * the library rather than telling us whether the glasses were involved. JS
 * rescans, which is where the recognizing happens anyway.
 */
- (void)photoLibraryDidChange:(PHChange *)changeInstance
{
  if (!self.hasListeners) {
    return;
  }
  [self sendEventWithName:GMLLibraryChangedEvent body:@{}];
}

@end
