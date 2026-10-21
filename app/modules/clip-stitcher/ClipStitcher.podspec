Pod::Spec.new do |s|
  s.name         = "ClipStitcher"
  s.version      = "1.0.0"
  s.summary      = "Clip stitching and cutting, wake-word listening and transcription, on-device caption burn-in, and photo-library import."
  s.homepage     = "https://example.invalid/fade-away"
  s.license      = "MIT"
  s.authors      = { "Fade Away" => "dev@fadeaway.local" }
  s.platforms    = { :ios => "16.0" }
  s.source       = { :path => "." }
  s.source_files = "ios/**/*.{h,m}"
  s.frameworks   = "AVFoundation", "CoreMedia", "UIKit", "Speech", "QuartzCore", "CoreText", "Accelerate", "Photos"

  s.dependency "React-Core"
end
