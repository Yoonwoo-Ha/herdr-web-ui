import XCTest
@testable import OvisHomeCore

final class BarsTests: XCTestCase {
    func testALightPageGetsDarkIcons() {
        for color in ["#ffffff", "#FFFFFF", "#f8f8f8", "#eeeae2", "#faf8f3", " #ffffff "] {
            XCTAssertEqual(Bars.icons(themeColor: color), .dark, color)
        }
    }

    func testADarkPageGetsLightIcons() {
        for color in ["#000000", "#12100e", "#1f1f1f", "#181613", "#2E3A59"] {
            XCTAssertEqual(Bars.icons(themeColor: color), .light, color)
        }
    }

    func testTheLineBetweenThemIsWhereAndroidDrawsIt() {
        // MainActivity.paintBars: dark icons above a luminance of 0.18
        XCTAssertEqual(Bars.icons(themeColor: "#757575"), .light)
        XCTAssertEqual(Bars.icons(themeColor: "#767676"), .dark)
        // by what the eye takes as bright, not by the sum of the channels
        XCTAssertEqual(Bars.icons(themeColor: "#00ff00"), .dark)
        XCTAssertEqual(Bars.icons(themeColor: "#ff0000"), .dark)
        XCTAssertEqual(Bars.icons(themeColor: "#0000ff"), .light)
        XCTAssertEqual(Bars.icons(themeColor: "#f0a830"), .dark)
    }

    func testAPageThatNamesNoReadableColourKeepsTheAppsOwnIcons() {
        // the app's start is dark, with light icons (capacitor.config.json): as before the bars followed the page
        XCTAssertEqual(Bars.fallback, .light)
        for color in ["", " ", "white", "#fff", "#ffffff80", "#gggggg", "ffffff", "rgb(255, 255, 255)", "#ffffff;", "＃ffffff"] {
            XCTAssertEqual(Bars.icons(themeColor: color), .light, color)
        }
        XCTAssertEqual(Bars.icons(themeColor: nil), .light)
    }

    func testANativeCoverIsJudgedByItsOwnColour() {
        // components from 0 to 1, as UIColor gives them
        XCTAssertEqual(Bars.icons(red: 1, green: 1, blue: 1), .dark)
        XCTAssertEqual(Bars.icons(red: 0x12 / 255.0, green: 0x10 / 255.0, blue: 0x0e / 255.0), .light)
        XCTAssertEqual(Bars.icons(red: 0, green: 0, blue: 0), .light)
        // a colour outside the range (a wide-gamut one) is read as its nearest in it
        XCTAssertEqual(Bars.icons(red: 1.2, green: 1.1, blue: 1.3), .dark)
        XCTAssertEqual(Bars.icons(red: -0.2, green: -0.1, blue: 0), .light)
    }

    func testAColourTooLongToBeOneIsUnreadable() {
        // a text is read up to 64 bytes: a longer one is not looked into, and is no colour
        XCTAssertEqual(Bars.icons(themeColor: "#ffffff" + String(repeating: " ", count: 57)), .dark)
        XCTAssertEqual(Bars.icons(themeColor: "#ffffff" + String(repeating: " ", count: 58)), .light)
        XCTAssertEqual(Bars.icons(themeColor: String(repeating: " ", count: 80) + "#ffffff"), .light)
    }

    func testWhatThePageSaysReplacesWhatItSaidBefore() {
        XCTAssertEqual(Bars.page(nil, said: "#ffffff"), .dark)
        XCTAssertEqual(Bars.page(.dark, said: "#1f1f1f"), .light)
        XCTAssertEqual(Bars.page(.light, said: "#ffffff"), .dark)
    }

    func testAPageThatStopsNamingAReadableColourGetsTheAppsOwnIcons() {
        // not the icons of the colour it named before: a white page that now names none, or one too long to be one
        XCTAssertEqual(Bars.page(.dark, said: ""), .light)
        XCTAssertEqual(Bars.page(.dark, said: "white"), .light)
        XCTAssertEqual(Bars.page(.dark, said: String(repeating: "f", count: 65)), .light)
        XCTAssertEqual(Bars.page(.dark, said: String(repeating: "#ffffff", count: 100_000)), .light)
    }

    func testANewDocumentHasSaidNothingYet() {
        // what the document before it said is not its colour
        XCTAssertNil(Bars.page(.dark, said: NSNull()))
        XCTAssertNil(Bars.page(.light, said: NSNull()))
        XCTAssertNil(Bars.page(nil, said: NSNull()))
    }

    func testAnythingElseIsNotThePagesWord() {
        let bodies: [Any] = [5, true, ["#ffffff"], ["color": "#ffffff"], Date(timeIntervalSince1970: 0)]
        for body in bodies {
            XCTAssertEqual(Bars.page(.dark, said: body), .dark, "\(body)")
            XCTAssertEqual(Bars.page(.light, said: body), .light, "\(body)")
            XCTAssertNil(Bars.page(nil, said: body), "\(body)")
        }
    }

    func testWhatIsOnScreenDecides() {
        // a cover over the page hides it, so the cover's colour counts; else what the page said
        XCTAssertEqual(Bars.icons(cover: .dark, page: .light, ground: .light), .dark)
        XCTAssertEqual(Bars.icons(cover: .light, page: .dark, ground: .dark), .light)
        XCTAssertEqual(Bars.icons(cover: nil, page: .dark, ground: .light), .dark)
        XCTAssertEqual(Bars.icons(cover: nil, page: .light, ground: .dark), .light)
        // a document that has not said yet shows the colour behind the web view
        XCTAssertEqual(Bars.icons(cover: nil, page: nil, ground: .dark), .dark)
        XCTAssertEqual(Bars.icons(cover: nil, page: nil, ground: .light), .light)
        XCTAssertEqual(Bars.icons(cover: .light, page: nil, ground: .dark), .light)
        // with nothing to go by, the app's own
        XCTAssertEqual(Bars.icons(cover: nil, page: nil, ground: nil), .light)
    }
}
