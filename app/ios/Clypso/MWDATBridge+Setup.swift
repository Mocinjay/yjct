import Foundation
import MWDATCamera
import MWDATCore
import React

/// Everything the app asks the glasses link *about* rather than *of*: what the
/// SDK currently reports, whether this app is registered with the Meta AI app,
/// and whether the wearer has granted camera access.
///
/// A Swift extension rather than a new type on purpose. These are RN-exported
/// entry points that read the bridge's own session state, so giving them a
/// separate object would mean either duplicating that state or threading a
/// reference back — both worse than a file boundary. The split here is about
/// making a 1100-line file navigable, not about inventing a collaborator.
extension MWDATBridge {
  // MARK: - Diagnostics

  /// Internal, not private: the bridge's own device listener re-emits this
  /// payload, and Swift scopes `private` to the file.
  func diagnosticsPayload() -> [String: Any] {
    let wearables = Wearables.shared
    let devices: [[String: Any]] = wearables.devices.compactMap { identifier in
      guard let device = wearables.deviceForIdentifier(identifier) else { return nil }
      return [
        "name": device.nameOrId(),
        "linkState": String(describing: device.linkState),
        "compatibility": device.compatibility().displayString,
        "type": String(describing: device.deviceType()),
      ]
    }
    return [
      "registration": wearables.registrationState.description,
      "devices": devices,
      "streamState": stream.map { String(describing: $0.state) } ?? "none",
      "recording": writer != nil,
    ]
  }

  @objc(getDiagnostics:reject:)
  func getDiagnostics(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
      return
    }
    Task { @MainActor in
      var payload = self.diagnosticsPayload()
      if Wearables.shared.registrationState == .registered {
        let status = await Self.withTimeout(seconds: 3) {
          try? await Wearables.shared.checkPermissionStatus(.camera)
        }
        payload["cameraPermission"] = status.map { String(describing: $0) } ?? "unknown"
      } else {
        payload["cameraPermission"] = "unknown"
      }
      resolve(payload)
    }
  }

  // MARK: - Registration

  @objc(getRegistrationState:reject:)
  func getRegistrationState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
      resolve(Wearables.shared.registrationState.description)
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
    }
  }

  @objc(startRegistration:reject:)
  func startRegistration(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
      return
    }
    Task { @MainActor in
      let state = Wearables.shared.registrationState
      Self.log(
        "startRegistration(): scheme=\(MWDATBridge.appLinkScheme):// "
          + "state=\(state.description)"
      )

      // Nothing to do, and asking anyway throws `.alreadyRegistered`.
      if state == .registered {
        resolve(state.description)
        return
      }

      // `.registering` is sticky. The SDK enters it when Meta AI is handed
      // control and leaves it only when the callback comes back — so an
      // approval the wearer abandoned, or a hand-back that never arrived,
      // parks the app here indefinitely. Starting a second registration on top
      // of the pending one is what produces Meta AI's own "Internal error"
      // instead of the approval page, and every further tap repeats it.
      //
      // The way out is `startUnregistration()`, which this bridge now exposes.
      // Say so rather than launching a request that cannot succeed.
      if state == .registering {
        Self.log("startRegistration(): already registering — refusing to re-enter")
        reject(
          "mwdat_registering",
          "A link to Meta AI is already in progress and has not come back. "
            + "Tap “Reset the Meta AI link”, then connect again.",
          nil
        )
        return
      }

      do {
        try await Wearables.shared.startRegistration()
        Self.log(
          "startRegistration(): returned, state=\(Wearables.shared.registrationState.description)"
        )
        resolve(Wearables.shared.registrationState.description)
      } catch let error as RegistrationError {
        // `startRegistration()` is declared `throws(RegistrationError)`, but
        // the target builds in Swift 5 language mode, where a typed throw is
        // erased to `any Error` at the catch site. The case has to be recovered
        // with an explicit `as` — reading it off `error` directly compiles only
        // under Swift 6.
        //
        // Worth the two clauses: the previous single `error.localizedDescription`
        // plus one blanket "is Developer Mode on?" gave the same sentence to a
        // missing app, a dead network and a malformed Info.plist.
        Self.log("startRegistration() FAILED: \(error.description)")
        let advice: String
        switch error {
        case .alreadyRegistered:
          advice = "Meta AI says this app is already linked. "
            + "Tap “Reset the Meta AI link”, then connect again."
        case .configurationInvalid:
          advice = "The app's Meta configuration is not valid — MWDAT keys in "
            + "Info.plist. This is a build problem, not something to retry."
        case .metaAINotInstalled:
          advice = "The Meta AI app is not installed. Install it and pair your "
            + "glasses there first."
        case .networkUnavailable:
          advice = "Registration needs an internet connection."
        case .timeout:
          advice = "Meta AI did not answer in time. Tap “Reset the Meta AI "
            + "link”, then connect again."
        case .unknown:
          advice = "Meta AI reported an unspecified failure. Check the glasses "
            + "are paired and connected in Meta AI, that Developer Mode is on "
            + "for them, then tap “Reset the Meta AI link” and connect again."
        }
        reject("mwdat_registration", "\(error.description) \(advice)", error)
      } catch {
        Self.log("startRegistration() FAILED (untyped): \(error)")
        reject(
          "mwdat_registration",
          "Registration with Meta AI failed: \(error.localizedDescription).",
          error
        )
      }
    }
  }

  /// Tears down the Meta AI link so it can be built again.
  ///
  /// The SDK has always had `startUnregistration()`; nothing exposed it, so a
  /// registration that stalled in `.registering` had no exit inside the app —
  /// every "Connect through Meta AI" tap re-entered the pending request and
  /// came back with Meta AI's internal error. This is the reset.
  @objc(unregister:reject:)
  func unregister(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
      return
    }
    Task { @MainActor in
      let before = Wearables.shared.registrationState
      Self.log("unregister(): state=\(before.description)")
      do {
        try await Wearables.shared.startUnregistration()
        let after = Wearables.shared.registrationState
        Self.log("unregister(): done, state=\(after.description)")
        resolve(after.description)
      } catch let error as UnregistrationError {
        Self.log("unregister() FAILED: \(error.description)")
        // Already unregistered is the state the caller wanted. Reporting it as
        // a failure would leave the wearer stuck on a reset that had worked.
        if case .alreadyUnregistered = error {
          resolve(Wearables.shared.registrationState.description)
          return
        }
        reject("mwdat_unregister", error.description, error)
      } catch {
        Self.log("unregister() FAILED (untyped): \(error)")
        reject("mwdat_unregister", error.localizedDescription, error)
      }
    }
  }

  // MARK: - Permission

  @objc(prepare:reject:)
  func prepare(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
      return
    }
    let wearables = Wearables.shared
    guard mockActive || wearables.registrationState == .registered else {
      reject(
        "mwdat_not_registered",
        "Glasses are not linked yet. Tap “Connect through Meta AI” first.",
        nil
      )
      return
    }
    Task { @MainActor in
      // No DiagnosticLog.reset() here either — see MWDATBridge.init(), which
      // truncates once per session. Resetting at any single operation erases
      // whichever operation ran before it.

      // Camera permission is granted *per glasses*, so asking for it with no
      // glasses connected is a request Meta AI cannot answer. It does not
      // decline it — it opens, fails internally, and shows
      // "Internal error - The operation could not be completed", which names
      // neither the cause nor anything the wearer can do. That alert was the
      // entire reported symptom, and this is the check that prevents it:
      // establish there is a device before leaving the app to ask about one.
      if !mockActive && wearables.devices.isEmpty {
        Self.log("prepare(): no devices — not requesting permission")
        let error = MWDATBridge.noEligibleDeviceError()
        reject("mwdat_no_device", error.localizedDescription, error)
        return
      }
      Self.log("prepare(): \(wearables.devices.count) device(s); checking camera permission…")
      // checkPermissionStatus can hang indefinitely (observed in the field);
      // never block the pipeline on it — a missing permission surfaces later
      // as a definitive StreamError.permissionDenied.
      let status = await Self.withTimeout(seconds: 8) {
        try? await wearables.checkPermissionStatus(.camera)
      }
      Self.log("prepare(): permission check → \(status.map { String(describing: $0) } ?? "TIMED OUT")")

      guard let status else {
        Self.log("prepare(): continuing despite timeout — stream will report permissionDenied if needed")
        resolve(nil)
        return
      }
      if status == .granted {
        resolve(nil)
        return
      }
      // This is the call that leaves the app: the SDK opens Meta AI so the
      // wearer can grant camera access. It is the single most failure-prone
      // step in the handshake and it happens in someone else's UI, so what
      // comes back matters more here than anywhere else in this file.
      Self.log("prepare(): requesting permission via Meta AI…")
      let outcome = await Self.withTimeout(seconds: 120) { () -> PermissionOutcome? in
        do {
          let status = try await wearables.requestPermission(.camera)
          if status == .granted { return .granted }
          if status == .denied { return .denied }
          return .inconclusive(String(describing: status))
        } catch {
          return .failed(error.localizedDescription)
        }
      }
      Self.log("prepare(): request → \(outcome.map(\.description) ?? "TIMED OUT")")

      switch outcome {
      case .granted:
        resolve(nil)
      case .denied:
        reject("mwdat_permission", "Camera access on the glasses was denied in Meta AI.", nil)
      case .failed(let reason):
        // Meta AI itself failed the request. Its own alert says "Internal
        // error - The operation could not be completed" and nothing else, so
        // if this is not named here the wearer is returned to Connect with a
        // dialog they cannot act on and no trace on our side. `try?` used to
        // flatten this into the same nil as a timeout, and the `else` branch
        // below resolved it as success — the pipeline then continued to
        // startPreview() and failed later, somewhere unrelated.
        reject(
          "mwdat_permission",
          "Meta AI could not complete the camera permission request: \(reason). "
            + "Check that the glasses show as Connected in Meta AI and that "
            + "Clypso is listed under Meta AI → Settings → App connections.",
          nil
        )
      case .inconclusive(let status):
        // Not a definitive no. Carry on for the same reason the check above
        // does not block: a genuinely missing permission resurfaces as
        // StreamError.permissionDenied, which names itself properly.
        Self.log("prepare(): permission neither granted nor denied (\(status)) — continuing")
        resolve(nil)
      case nil:
        Self.log("prepare(): permission request timed out — continuing")
        resolve(nil)
      }
    }
  }

  /// What a permission round trip through Meta AI actually did.
  ///
  /// `requestPermission` can return a status, throw, or never come back, and
  /// `try?` collapsed the middle case into the same `nil` as the last one —
  /// so a Meta AI failure and a slow user were indistinguishable, and both
  /// were treated as success.
  enum PermissionOutcome: Sendable {
    case granted
    case denied
    case inconclusive(String)
    case failed(String)

    var description: String {
      switch self {
      case .granted: return "granted"
      case .denied: return "denied"
      case .inconclusive(let status): return "inconclusive(\(status))"
      case .failed(let reason): return "FAILED(\(reason))"
      }
    }
  }

  private static func withTimeout<T: Sendable>(
    seconds: UInt64,
    _ operation: @escaping @Sendable () async -> T?
  ) async -> T? {
    await withTaskGroup(of: T?.self) { group in
      group.addTask { await operation() }
      group.addTask {
        try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
        return nil
      }
      let result = await group.next() ?? nil
      group.cancelAll()
      return result
    }
  }
}
