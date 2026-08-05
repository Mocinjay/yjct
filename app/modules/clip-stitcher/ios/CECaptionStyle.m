#import "CECaptionStyle.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreText/CoreText.h>

UIColor *CEColorFromHex(NSString *hex, UIColor *fallback)
{
  if (![hex isKindOfClass:[NSString class]]) {
    return fallback;
  }
  NSString *cleaned = [hex stringByReplacingOccurrencesOfString:@"#" withString:@""];
  if (cleaned.length != 6) {
    return fallback;
  }
  unsigned int value = 0;
  if (![[NSScanner scannerWithString:cleaned] scanHexInt:&value]) {
    return fallback;
  }
  return [UIColor colorWithRed:((value >> 16) & 0xFF) / 255.0
                         green:((value >> 8) & 0xFF) / 255.0
                          blue:(value & 0xFF) / 255.0
                         alpha:1.0];
}

double CEDouble(NSDictionary *dict, NSString *key, double fallback)
{
  id value = dict[key];
  return [value isKindOfClass:[NSNumber class]] ? [value doubleValue] : fallback;
}

/// Text attributes for one word.
///
/// The heavy outline is NSStrokeWidth, which Core Text expresses as a
/// percentage of the font size - the same relationship the ASS styles use, so
/// `outlineScale` carries over unchanged. It must be negative: a positive
/// stroke width draws the outline *instead of* the fill, which renders the
/// captions as hollow letters.
NSDictionary *CETextAttributes(UIFont *font, UIColor *color, double outlineScale,
                                      UIColor *outlineColor)
{
  NSMutableDictionary *attributes = [@{
    NSFontAttributeName : font,
    NSForegroundColorAttributeName : color,
  } mutableCopy];
  if (outlineScale > 0) {
    attributes[NSStrokeWidthAttributeName] = @(-outlineScale * 100.0);
    attributes[NSStrokeColorAttributeName] = outlineColor;
  }
  return attributes;
}

/// Opacity keyframes covering the whole export, since a layer added to the
/// animation tool has no timeline of its own.
///
/// `beginTime` must be AVCoreAnimationBeginTimeAtZero, not 0: Core Animation
/// reads a zero begin time as "now", which on an export timeline means the
/// animation is already over before the first frame is written.
CAKeyframeAnimation *CEOpacityAnimation(double start, double end, double total,
                                               double fadeIn, double fadeOut)
{
  NSMutableArray<NSNumber *> *times = [NSMutableArray array];
  NSMutableArray<NSNumber *> *values = [NSMutableArray array];
  __block double lastTime = -1.0;
  void (^add)(double, double) = ^(double time, double value) {
    double clamped = MAX(0.0, MIN(1.0, time));
    // Keyframe times must strictly increase; a caption shorter than the fade
    // would otherwise emit a duplicate and the animation is dropped whole.
    if (clamped <= lastTime) {
      clamped = MIN(1.0, lastTime + 1e-6);
    }
    lastTime = clamped;
    [times addObject:@(clamped)];
    [values addObject:@(value)];
  };

  double span = MAX(end - start, 1e-3);
  double in = MIN(fadeIn, span * 0.4);
  double out = MIN(fadeOut, span * 0.4);
  // With no fade the layer must snap on, so the keyframes are stepped rather
  // than interpolated. Interpolating instead would ramp the value from the
  // previous keyframe, which for a highlight means it starts glowing seconds
  // before its word is spoken.
  BOOL stepped = (in <= 0 && out <= 0);

  if (start > 0) {
    add(0.0, 0.0);
    // Stepped holds this value until the next key, so the visible window opens
    // here. Interpolated has to stay dark and ramp up over the fade instead.
    add(start / total, stepped ? 1.0 : 0.0);
  } else {
    add(0.0, 1.0);
  }
  if (in > 0) {
    add((start + in) / total, 1.0);
  }
  if (out > 0) {
    add((end - out) / total, 1.0);
  }
  add(end / total, 0.0);
  if (end < total) {
    add(1.0, 0.0);
  }

  CAKeyframeAnimation *animation = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
  animation.keyTimes = times;
  animation.values = values;
  animation.calculationMode = stepped ? kCAAnimationDiscrete : kCAAnimationLinear;
  animation.beginTime = AVCoreAnimationBeginTimeAtZero;
  animation.duration = total;
  animation.removedOnCompletion = NO;
  animation.fillMode = kCAFillModeBoth;
  return animation;
}
