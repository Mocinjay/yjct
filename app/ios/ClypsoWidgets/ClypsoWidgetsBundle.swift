import SwiftUI
import WidgetKit

/// Entry point for the widget extension. Only the Live Activity ships today;
/// home-screen widgets would be added to this bundle.
@main
struct ClypsoWidgetsBundle: WidgetBundle {
  var body: some Widget {
    if #available(iOS 16.2, *) {
      ClypsoLiveActivity()
    }
  }
}
