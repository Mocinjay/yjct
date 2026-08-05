#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Turning the style dictionary that crosses the bridge into the Core
/// Animation/Core Text objects that draw a caption.
///
/// Split out of CaptionEngine.m because it is presentation, not pipeline: hex
/// parsing, text attributes and a fade curve, none of which touch an asset, a
/// recognizer or an export session.
///
/// The layout rules themselves deliberately do NOT live here — chunking,
/// per-word highlight spans, the non-overlap clamp and line layout are all in
/// TypeScript (`src/captions/captionTimeline.ts`), where they can be tested
/// without a device. Native draws what it is told; this file is only about
/// how the drawing is configured.

/// Parses `#RRGGBB` / `#AARRGGBB`, falling back when the value is unusable.
///
/// `fallback` is nullable, and so is the result: the highlight colour is
/// genuinely optional — a style with no highlight passes nil here and expects
/// nil back, which is how "no second text layer" is expressed.
UIColor *_Nullable CEColorFromHex(NSString *_Nullable hex,
                                  UIColor *_Nullable fallback);

/// Reads a numeric field from a bridge dictionary, falling back when absent.
double CEDouble(NSDictionary *_Nullable dict, NSString *key, double fallback);

/// Attributes for one caption word: font, fill, and the stroke that keeps text
/// legible over arbitrary footage.
NSDictionary *CETextAttributes(UIFont *font, UIColor *color, double outlineScale,
                               UIColor *outlineColor);

/// Fades a layer in at `start` and out at `end` on a composition timeline of
/// length `total`, over the given fade durations.
///
/// A caption is drawn as two stacked text layers — base and highlight — because
/// a CATextLayer's attributed string is not animatable. The highlight is a
/// second copy faded in over the first, which is what this drives.
CAKeyframeAnimation *CEOpacityAnimation(double start, double end, double total,
                                        double fadeIn, double fadeOut);

NS_ASSUME_NONNULL_END
