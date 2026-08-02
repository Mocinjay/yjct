import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "Clipso",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  /// The glasses hold the capture slot until the session is explicitly stopped.
  /// If the app is killed without releasing it, every later stream start fails
  /// until the glasses are power-cycled — so terminate ALWAYS releases.
  func applicationWillTerminate(_ application: UIApplication) {
    MWDATBridge.releaseGlassesForAppLifecycle("willTerminate")
  }

  /// Background does NOT always release: an armed capture is meant to survive,
  /// since the point of the product is clipping while the phone is pocketed and
  /// you are using something else. `releaseGlassesForAppLifecycle` keeps the
  /// session when a writer is active and drops preview-only ones.
  ///
  /// The residual risk is jetsam — if iOS memory-kills us in the background,
  /// `applicationWillTerminate` does not run and the capture slot stays held.
  func applicationDidEnterBackground(_ application: UIApplication) {
    MWDATBridge.releaseGlassesForAppLifecycle("didEnterBackground")
  }

  /// Meta AI returns control here (jarvis:// scheme) after glasses
  /// registration; MWDATBridge forwards it into the Wearables SDK.
  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    MWDATBridge.handleOpenURL(url)
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
