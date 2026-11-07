import Foundation

// Definition of the C-function signature for MRMediaRemoteGetNowPlayingInfo
typealias MRMediaRemoteGetNowPlayingInfoFunction = @convention(c) (DispatchQueue, @escaping ([String: Any]) -> Void) -> Void

struct NowPlayingPayload: Codable {
    let hasMedia: Bool
    let title: String
    let artist: String
    let album: String
    let duration: Double
    let elapsed: Double
    let playbackRate: Double
    let isPlaying: Bool
}

func fetchNowPlaying() -> NowPlayingPayload {
    guard let bundle = CFBundleCreate(kCFAllocatorDefault, NSURL(fileURLWithPath: "/System/Library/PrivateFrameworks/MediaRemote.framework")),
          let pointer = CFBundleGetFunctionPointerForName(bundle, "MRMediaRemoteGetNowPlayingInfo" as CFString) else {
        return NowPlayingPayload(hasMedia: false, title: "", artist: "", album: "", duration: 0, elapsed: 0, playbackRate: 0, isPlaying: false)
    }

    let MRMediaRemoteGetNowPlayingInfo = unsafeBitCast(pointer, to: MRMediaRemoteGetNowPlayingInfoFunction.self)
    let sem = DispatchSemaphore(value: 0)
    var result = NowPlayingPayload(hasMedia: false, title: "", artist: "", album: "", duration: 0, elapsed: 0, playbackRate: 0, isPlaying: false)

    MRMediaRemoteGetNowPlayingInfo(DispatchQueue.global()) { info in
        let title = info["kMRMediaRemoteNowPlayingInfoTitle"] as? String ?? ""
        let artist = info["kMRMediaRemoteNowPlayingInfoArtist"] as? String ?? ""
        let album = info["kMRMediaRemoteNowPlayingInfoAlbum"] as? String ?? ""
        let duration = info["kMRMediaRemoteNowPlayingInfoDuration"] as? Double ?? 0.0
        let elapsed = info["kMRMediaRemoteNowPlayingInfoElapsedTime"] as? Double ?? 0.0
        let rate = info["kMRMediaRemoteNowPlayingInfoPlaybackRate"] as? Double ?? 0.0
        let isPlaying = rate > 0.0

        if !title.isEmpty || !artist.isEmpty {
            result = NowPlayingPayload(
                hasMedia: true,
                title: title,
                artist: artist,
                album: album,
                duration: duration,
                elapsed: elapsed,
                playbackRate: rate,
                isPlaying: isPlaying
            )
        }
        sem.signal()
    }

    _ = sem.wait(timeout: .now() + 1.5)
    return result
}

let payload = fetchNowPlaying()
let encoder = JSONEncoder()
if let jsonData = try? encoder.encode(payload),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else {
    print("{\"hasMedia\":false,\"title\":\"\",\"artist\":\"\",\"album\":\"\",\"duration\":0,\"elapsed\":0,\"playbackRate\":0,\"isPlaying\":false}")
}
