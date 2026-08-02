import ActivityKit
import SwiftUI
import WidgetKit

/// The "LIVE" surface: Lock Screen banner and Dynamic Island.
///
/// This is the whole point of the widget — the wearer is out with the phone
/// pocketed, using some other app, and needs to know at a glance that Clipso
/// is still listening and how many clips it has saved so far.
@available(iOS 16.2, *)
struct ClipsoLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ClipsoActivityAttributes.self) { context in
      LockScreenView(context: context)
        .activityBackgroundTint(Color.black.opacity(0.55))
        .activitySystemActionForegroundColor(Color.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          StatusDot(recording: context.state.recording)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.recording ? "REC" : "LIVE")
            .font(.caption.weight(.heavy))
            .foregroundStyle(recColor)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.attributes.deviceName)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack {
            Text(bufferLine(context.state))
              .font(.caption2)
              .foregroundStyle(.secondary)
            Spacer()
            Text(savesLine(context.state.clipCount))
              .font(.caption2.weight(.semibold))
              .foregroundStyle(.white)
          }
        }
      } compactLeading: {
        StatusDot(recording: context.state.recording)
      } compactTrailing: {
        // The save count is the single most useful glanceable number: it is
        // how the wearer confirms the last "Clipso" actually landed.
        Text("\(context.state.clipCount)")
          .font(.caption2.weight(.bold))
          .foregroundStyle(recColor)
      } minimal: {
        StatusDot(recording: context.state.recording)
      }
      .keylineTint(recColor)
    }
  }
}

/// Clipso's REC-red, matching `ui/theme.ts` `colors.accent`.
private let recColor = Color(red: 1.0, green: 0.23, blue: 0.36)

@available(iOS 16.2, *)
private struct StatusDot: View {
  let recording: Bool
  var body: some View {
    Circle()
      .fill(recColor)
      .frame(width: 10, height: 10)
      .opacity(recording ? 1.0 : 0.75)
      .accessibilityLabel(recording ? "Recording" : "Live")
  }
}

@available(iOS 16.2, *)
private struct LockScreenView: View {
  let context: ActivityViewContext<ClipsoActivityAttributes>

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      StatusDot(recording: context.state.recording)

      VStack(alignment: .leading, spacing: 2) {
        Text(context.state.recording ? "RECORDING" : "LIVE")
          .font(.caption.weight(.heavy))
          .kerning(1.2)
          .foregroundStyle(recColor)

        Text(bufferLine(context.state))
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      VStack(alignment: .trailing, spacing: 2) {
        // A recording shows a self-updating timer so the activity does not
        // need an update pushed every second just to tick.
        if context.state.recording, let since = context.state.recordingSince {
          Text(since, style: .timer)
            .font(.system(.body, design: .rounded).weight(.bold))
            .monospacedDigit()
            .foregroundStyle(.white)
        } else {
          Text("\(context.state.clipCount)")
            .font(.system(.title3, design: .rounded).weight(.bold))
            .foregroundStyle(.white)
        }

        Text(savesLine(context.state.clipCount))
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

private func bufferLine(_ state: ClipsoActivityAttributes.ContentState) -> String {
  state.recording
    ? "look-back + everything since you started"
    : "say “Clipso” · \(state.bufferedSeconds)s buffered"
}

private func savesLine(_ count: Int) -> String {
  count == 1 ? "1 save" : "\(count) saves"
}
