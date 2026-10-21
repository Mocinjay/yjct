#import <AVFoundation/AVFoundation.h>
#import <Photos/Photos.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

#import "CSDiagnostics.h"

/**
 * Finds recordings the glasses made on their own and hands them over intact.
 *
 * The toolkit's camera stream tops out at 720x1280. What the glasses write to
 * their own storage is a different file: 1520x2032 HEVC in HLG colour, about
 * three and a half times the pixels, with none of the link's compression. No
 * API reaches that file. Meta AI syncs it into the photo library like any
 * camera would, so this module watches the library, recognises what came off
 * the glasses, and copies the original bytes. It never writes to the library.
 */

#define GMLLog(fmt, ...) CSLog(@"GlassesMediaLibrary", fmt, ##__VA_ARGS__)

/// Emitted when the library changes, so JS can rescan.
static NSString *const GMLLibraryChangedEvent = @"GlassesMediaLibraryChanged";

/**
 * Substring that marks an asset as the glasses'. AVFoundation surfaces
 * `com.apple.quicktime.model` under the common `model` key; a Ray-Ban Meta
 * recording carries "Ray-Ban Meta Smart Glasses". A substring rather than the
 * whole string lets the Oakley and Display models through without a new entry.
 */
static NSString *const GMLGlassesModelMarker = @"Meta";
/// Second opinion: every file Meta AI writes carries this copyright.
static NSString *const GMLGlassesCopyright = @"Meta AI";

/// Where exported originals are copied before cutting. Caches, because each
/// copy is deleted once cut; a copy left by a killed import is swept later.
static NSString *GMLImportDirectory(void)
{
  return [NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES)
              .firstObject stringByAppendingPathComponent:@"glasses-imports"];
}

/// Copies older than this belong to an import that never finished.
static const NSTimeInterval kGMLStaleImportSeconds = 3600;

@interface GlassesMediaLibrary : RCTEventEmitter <RCTBridgeModule, PHPhotoLibraryChangeObserver>
@property (nonatomic, assign) BOOL hasListeners;
@property (nonatomic, assign) BOOL watching;
/// localIdentifier -> @(BOOL). Deciding whether an asset came off the glasses
/// means opening it; a day of rescans should pay that once per asset.
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

#pragma mark - Diagnostics

/// Lets the JS half of the import write its decisions (which markers matched,
/// where a cut landed) into the same diagnostics file as this module.
RCT_EXPORT_METHOD(log:(NSString *)message)
{
  CSDiagAppend(@"glasses-import", message);
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
    // "limited" reads fine but only sees hand-picked assets, and nobody
    // hand-picks each recording as Meta AI syncs it. For this feature it is
    // as good as denied.
    @"usable" : @(status == PHAuthorizationStatusAuthorized),
  };
}

/**
 * Asks for access, prompting if the wearer has not been asked.
 *
 * `PHAccessLevelReadWrite` is the only level that grants reads (`AddOnly`
 * permits writing and nothing else), so it is what has to be asked for even
 * though nothing here writes.
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
 * Current access, without prompting. Access revoked in Settings notifies
 * nobody, so the app re-checks on every foreground, and a check must never put
 * a prompt in front of someone out wearing the glasses.
 */
RCT_EXPORT_METHOD(currentAccess:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve(GMLAccessPayload(
      [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite]));
}

#pragma mark - Recognition

/**
 * When the glasses started recording. `com.apple.quicktime.creationdate` is
 * written at capture start; the container's own dates are set when Meta AI
 * finishes transferring (56 s later on a 17 s clip, measured). Only the
 * capture start can place a spoken marker inside the video.
 */
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
  // Photos copies the same value onto the asset, so this is a near-equivalent.
  return phAsset.creationDate;
}

/**
 * The model and copyright strings the identity test looked at, for a log line.
 * A rejected recording is otherwise indistinguishable from one that never
 * synced; printing what the metadata held says which literal to widen.
 */
static NSString *GMLDescribeIdentity(AVAsset *asset)
{
  NSMutableArray<NSString *> *seen = [NSMutableArray array];
  for (AVMetadataItem *item in
       [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                      withKey:AVMetadataCommonKeyModel
                                     keySpace:AVMetadataKeySpaceCommon]) {
    [seen addObject:[NSString stringWithFormat:@"model='%@'", item.stringValue ?: @"(nil)"]];
  }
  for (AVMetadataItem *item in
       [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                      withKey:AVMetadataCommonKeyCopyrights
                                     keySpace:AVMetadataKeySpaceCommon]) {
    [seen addObject:[NSString stringWithFormat:@"copyright='%@'",
                                               item.stringValue ?: @"(nil)"]];
  }
  if (seen.count == 0) {
    return @"no model or copyright metadata at all";
  }
  return [seen componentsJoinedByString:@" "];
}

/**
 * Did this come off a pair of Meta glasses? A model naming both "Meta" and
 * "Glasses", or Meta AI's copyright. Deliberately strict: a match is what lets
 * a recording be copied at all, and anything else is left alone.
 */
static BOOL GMLIsGlassesAsset(AVAsset *asset)
{
  for (AVMetadataItem *item in
       [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                      withKey:AVMetadataCommonKeyModel
                                     keySpace:AVMetadataKeySpaceCommon]) {
    NSString *value = item.stringValue;
    if ([value containsString:GMLGlassesModelMarker] && [value containsString:@"Glasses"]) {
      return YES;
    }
  }
  for (AVMetadataItem *item in
       [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                      withKey:AVMetadataCommonKeyCopyrights
                                     keySpace:AVMetadataKeySpaceCommon]) {
    if ([item.stringValue isEqualToString:GMLGlassesCopyright]) {
      return YES;
    }
  }
  return NO;
}

/// Ceiling on one Photos asset request. Local delivery is fast; this only has
/// to be longer than the slowest healthy read.
static const int64_t kGMLAssetRequestTimeoutSec = 30;

/**
 * Loads an asset without reaching for the network. A scan runs unattended,
 * often on cellular, so originals still in iCloud are reported as pending
 * rather than downloaded on the wearer's behalf. Bounded, because Photos can
 * leave a request outstanding indefinitely (a corrupt asset, the media daemon
 * restarting) and one such asset would otherwise hang every scan behind it.
 */
static AVAsset *GMLLoadLocalAsset(PHAsset *phAsset)
{
  PHVideoRequestOptions *options = [[PHVideoRequestOptions alloc] init];
  options.networkAccessAllowed = NO;
  options.deliveryMode = PHVideoRequestOptionsDeliveryModeHighQualityFormat;
  options.version = PHVideoRequestOptionsVersionOriginal;

  // Guards `result` against the handler still running after a timeout.
  NSLock *lock = [[NSLock alloc] init];
  __block AVAsset *result = nil;
  __block BOOL abandoned = NO;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  PHImageRequestID request = [[PHImageManager defaultManager]
      requestAVAssetForVideo:phAsset
                     options:options
               resultHandler:^(AVAsset *avAsset, AVAudioMix *mix, NSDictionary *info) {
                 [lock lock];
                 if (!abandoned) {
                   result = avAsset;
                 }
                 [lock unlock];
                 dispatch_semaphore_signal(done);
               }];
  if (dispatch_semaphore_wait(
          done, dispatch_time(DISPATCH_TIME_NOW, kGMLAssetRequestTimeoutSec * NSEC_PER_SEC)) != 0) {
    [lock lock];
    abandoned = YES;
    [lock unlock];
    [[PHImageManager defaultManager] cancelImageRequest:request];
    GMLLog(@"timed out after %llds requesting asset %@ - treating as unreadable",
           kGMLAssetRequestTimeoutSec, phAsset.localIdentifier);
    return nil;
  }
  [lock lock];
  AVAsset *const loaded = result;
  [lock unlock];
  return loaded;
}

#pragma mark - Scanning

/**
 * Every video created at or after `sinceMs`, newest first, glasses or not.
 *
 * Cheap on purpose: everything comes off the `PHAsset`, so nothing is opened,
 * decoded or downloaded. The caller keeps only videos a marker points into
 * before paying for `confirmGlassesVideo`, so footage nobody marked is never
 * examined, let alone copied.
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
  // An hour of slack: Photos dates an asset from its QuickTime creation date,
  // so a recording that synced late can carry an earlier date than expected.
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
      // Good enough to filter by; `confirmGlassesVideo` re-reads the exact
      // capture time before anything is cut.
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
 * Opens one asset and decides whether the glasses recorded it. The expensive
 * half, reached only for videos a marker already points into. Re-reads the
 * capture time from the container, which is the number the cut depends on.
 */
RCT_EXPORT_METHOD(confirmGlassesVideo:(NSString *)localIdentifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  PHAsset *phAsset =
      [PHAsset fetchAssetsWithLocalIdentifiers:@[ localIdentifier ] options:nil].firstObject;
  if (phAsset == nil) {
    reject(@"not_found", @"That recording is no longer in the photo library.", nil);
    return;
  }

  AVAsset *avAsset = GMLLoadLocalAsset(phAsset);
  if (avAsset == nil) {
    // Still in iCloud (or unreadable for now). Not a verdict: caching it would
    // hide the asset even after it lands.
    resolve(@{ @"isGlasses" : @NO, @"pendingDownload" : @YES });
    return;
  }

  NSNumber *cached = [self.verdicts objectForKey:localIdentifier];
  BOOL const isGlasses = cached != nil ? cached.boolValue : GMLIsGlassesAsset(avAsset);
  [self.verdicts setObject:@(isGlasses) forKey:localIdentifier];

  if (!isGlasses) {
    // Logged on the first verdict only; the verdict is cached and a marked
    // recording is re-offered on every library change. This is the line to
    // read first when a worn session produces no full-resolution clips: the
    // trigger WAS heard and the file DID sync, and only the identity test
    // failed, with the strings it saw right here.
    if (cached == nil) {
      GMLLog(@"NOT glasses footage: %@ - wanted model containing '%@' and "
             @"'Glasses', or copyright '%@' [%@]",
             GMLDescribeIdentity(avAsset), GMLGlassesModelMarker, GMLGlassesCopyright,
             localIdentifier);
    }
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

/// Deletes copies left behind by imports that never finished.
static void GMLSweepStaleImports(NSString *directory)
{
  NSFileManager *files = [NSFileManager defaultManager];
  NSDate *cutoff = [NSDate dateWithTimeIntervalSinceNow:-kGMLStaleImportSeconds];
  for (NSString *name in [files contentsOfDirectoryAtPath:directory error:NULL]) {
    NSString *path = [directory stringByAppendingPathComponent:name];
    NSDate *modified = [files attributesOfItemAtPath:path error:NULL].fileModificationDate;
    if (modified != nil && [modified compare:cutoff] == NSOrderedAscending) {
      [files removeItemAtPath:path error:NULL];
    }
  }
}

/**
 * Copies an asset's original bytes into app storage. `PHAssetResourceManager`
 * writes the file exactly as the glasses recorded it; an export session would
 * re-encode, flattening the HLG colour and spending a generation of quality,
 * which is what this whole path exists to avoid. The caller deletes the copy
 * once it has been cut.
 */
RCT_EXPORT_METHOD(exportOriginal:(NSString *)localIdentifier
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  PHAsset *phAsset =
      [PHAsset fetchAssetsWithLocalIdentifiers:@[ localIdentifier ] options:nil].firstObject;
  if (phAsset == nil) {
    reject(@"not_found", @"That recording is no longer in the photo library.", nil);
    return;
  }

  PHAssetResource *video = nil;
  for (PHAssetResource *resource in [PHAssetResource assetResourcesForAsset:phAsset]) {
    if (resource.type == PHAssetResourceTypeFullSizeVideo) {
      video = resource;
      break;
    }
    if (resource.type == PHAssetResourceTypeVideo) {
      video = resource;
    }
  }
  if (video == nil) {
    reject(@"no_resource", @"That recording has no video data.", nil);
    return;
  }

  NSString *directory = GMLImportDirectory();
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:NULL];
  GMLSweepStaleImports(directory);
  NSString *extension = video.originalFilename.pathExtension.length > 0
                            ? video.originalFilename.pathExtension
                            : @"mov";
  NSString *name = [NSString stringWithFormat:@"glasses-%@.%@",
                                              [[NSUUID UUID] UUIDString], extension];
  NSString *path = [directory stringByAppendingPathComponent:name];

  PHAssetResourceRequestOptions *options = [[PHAssetResourceRequestOptions alloc] init];
  // Unlike the scan, this may reach iCloud: a marker asked for this recording,
  // so the download is the thing the wearer wants.
  options.networkAccessAllowed = YES;

  [[PHAssetResourceManager defaultManager]
      writeDataForAssetResource:video
                         toFile:[NSURL fileURLWithPath:path]
                        options:options
              completionHandler:^(NSError *error) {
                if (error != nil) {
                  GMLLog(@"export FAILED for %@ - %@ [%@ %ld]", localIdentifier,
                         error.localizedDescription, error.domain, (long)error.code);
                  [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
                  reject(@"export_failed", error.localizedDescription, error);
                  return;
                }
                unsigned long long const bytes =
                    [[[NSFileManager defaultManager] attributesOfItemAtPath:path error:NULL]
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
 * Something in the library changed. A nudge, not a payload: this fires for
 * edits, favourites and deletions as readily as for a new recording, so JS
 * rescans and the recognising happens there.
 */
- (void)photoLibraryDidChange:(PHChange *)changeInstance
{
  if (!self.hasListeners) {
    return;
  }
  [self sendEventWithName:GMLLibraryChangedEvent body:@{}];
}

@end
