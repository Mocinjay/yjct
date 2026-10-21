#import <Foundation/Foundation.h>
#import <fcntl.h>
#import <unistd.h>

/**
 * Appends one line to Documents/clipso-diagnostics.log, the file the Swift
 * `DiagnosticLog` (MWDATSegmentWriter.swift) writes too, so a single pull off
 * the device reads as one timeline across capture, import, cutting and
 * captioning.
 *
 * O_APPEND makes each line one atomic write, so the several writers in the
 * process never interleave inside a line. Writes go through one serial queue
 * per translation unit and never block the caller.
 */
static inline void CSDiagAppend(NSString *tag, NSString *message)
{
  static NSString *path;
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                                NSUserDomainMask, YES).firstObject
        stringByAppendingPathComponent:@"clipso-diagnostics.log"];
    queue = dispatch_queue_create("com.mocinjay.clipso.csdiag", DISPATCH_QUEUE_SERIAL);
  });
  if (path == nil) {
    return;
  }
  NSString *line = [NSString
      stringWithFormat:@"%@ [%@] %@\n",
                       [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
                       tag, message];
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

/**
 * NSLog with file/line for the console, and the same message without them in
 * the diagnostics file. Format strings stay ASCII: a non-ASCII literal becomes
 * a UTF-16 CFString that `strings` cannot find in an installed build.
 */
#define CSLog(tag, fmt, ...)                                                   \
  do {                                                                         \
    NSLog(@"[%@] %s:%d %s: " fmt, tag,                                         \
          [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,    \
          ##__VA_ARGS__);                                                      \
    CSDiagAppend(tag, [NSString stringWithFormat:fmt, ##__VA_ARGS__]);         \
  } while (0)
