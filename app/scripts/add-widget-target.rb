# Adds the ClipsoWidgets Live Activity extension target to Clipso.xcodeproj.
#
# Uses the xcodeproj gem (the same library CocoaPods drives) rather than hand
# editing project.pbxproj, so the object graph, UUIDs and build phases stay
# internally consistent.
#
# Idempotent: re-running is a no-op once the target exists.
#
#     cd app && bundle exec ruby scripts/add-widget-target.rb
#
require 'xcodeproj'

ROOT = File.expand_path('..', __dir__)
PROJECT = File.join(ROOT, 'ios', 'Clipso.xcodeproj')
TARGET_NAME = 'ClipsoWidgets'

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == 'Clipso' } or abort 'Clipso target not found'

if project.targets.any? { |t| t.name == TARGET_NAME }
  puts "#{TARGET_NAME} already exists — nothing to do."
  exit 0
end

# --- new app-target sources ------------------------------------------------
# The Live Activity bridge and the shared attributes type are new files, so
# they have to join the app target before anything can reference them.
app_group = project.main_group.find_subpath('Clipso', true)
%w[
  ClipsoActivityAttributes.swift
  LiveActivityBridge.swift
  LiveActivityBridge.m
].each do |name|
  next if app.source_build_phase.files.any? { |f| f.file_ref&.path&.end_with?(name) }

  # The "Clipso" group carries no path of its own, so every child spells out
  # the "Clipso/" prefix itself (see the existing MWDATBridge.swift ref).
  # A bare filename resolves against SOURCE_ROOT — i.e. ios/ — and the build
  # fails with "Build input file cannot be found".
  path = "Clipso/#{name}"
  file = app_group.files.find { |f| f.path == path } || app_group.new_file(path)
  app.add_file_references([file])
  puts "  + Clipso: #{name}"
end

# --- the target ------------------------------------------------------------
widget = project.new_target(
  :app_extension,
  TARGET_NAME,
  :ios,
  '16.2',
  project.products_group,
  :swift
)

# --- build settings --------------------------------------------------------
# Signing (DEVELOPMENT_TEAM / PRODUCT_BUNDLE_IDENTIFIER) is deliberately NOT
# set here: scripts/setup.sh fails the build if either appears in the pbxproj,
# because Xcode's UI writes one developer's identity in and it overrides the
# xcconfig for everyone. Both come from Config/Widgets.xcconfig.
widgets_config = project.new_file('Config/Widgets.xcconfig')
widget.build_configurations.each do |config|
  config.base_configuration_reference = widgets_config
  config.build_settings.merge!(
    'INFOPLIST_FILE' => 'ClipsoWidgets/Info.plist',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'SKIP_INSTALL' => 'YES',
    'ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES' => 'NO',
    'CODE_SIGN_STYLE' => 'Automatic',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'LD_RUNPATH_SEARCH_PATHS' => [
      '$(inherited)',
      '@executable_path/Frameworks',
      '@executable_path/../../Frameworks'
    ]
  )
end

# --- sources ---------------------------------------------------------------
group = project.main_group.find_subpath(TARGET_NAME, true)
group.set_source_tree('SOURCE_ROOT')
group.set_path(TARGET_NAME)

%w[ClipsoWidgetsBundle.swift ClipsoLiveActivity.swift].each do |name|
  file = group.new_file(name)
  widget.add_file_references([file])
end

# The attributes type is the contract between the two targets, so it compiles
# into BOTH. ActivityKit matches app and extension by type name; two separate
# declarations would drift and silently stop matching.
attributes = app.source_build_phase.files.find do |f|
  f.file_ref&.path&.end_with?('ClipsoActivityAttributes.swift')
end
abort 'ClipsoActivityAttributes.swift is not in the Clipso target' unless attributes
widget.add_file_references([attributes.file_ref])

# Info.plist is referenced but never compiled.
group.new_file('Info.plist')

# --- embed into the app ----------------------------------------------------
embed = app.build_phases.find do |phase|
  phase.respond_to?(:name) && phase.name == 'Embed Foundation Extensions'
end
unless embed
  embed = project.new(Xcodeproj::Project::Object::PBXCopyFilesBuildPhase)
  embed.name = 'Embed Foundation Extensions'
  embed.symbol_dst_subfolder_spec = :plug_ins
  app.build_phases << embed
end
embed.add_file_reference(widget.product_reference, true)
embed.files.last.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

app.add_dependency(widget)

project.save
puts "Added #{TARGET_NAME} and embedded it in Clipso."
