import CryptoKit
import Foundation

/// OpenBSD's bcrypt_pbkdf, the key derivation of an OpenSSH private key with a passphrase (`ssh-keygen`'s
/// default since 7.8), from its reference (openbsd/src lib/libutil/bcrypt_pbkdf.c), over Blowfish's
/// expensive key schedule. SshKeysTest's `-pass` keys check it: a wrong derivation never opens them.
enum BcryptPbkdf {
    static func derive(password: Data, salt: Data, rounds: Int, length: Int) -> Data? {
        guard rounds >= 1, length >= 1, length <= 1024, !salt.isEmpty else { return nil }
        let hashLength = 32
        let stride = (length + hashLength - 1) / hashLength
        let amount = (length + stride - 1) / stride
        let sha2pass = Data(SHA512.hash(data: password))
        var key = [UInt8](repeating: 0, count: length)
        var remaining = length
        var count: UInt32 = 1
        while remaining > 0 {
            var countSalt = salt
            countSalt.append(contentsOf: [UInt8(count >> 24), UInt8((count >> 16) & 0xff), UInt8((count >> 8) & 0xff), UInt8(count & 0xff)])
            var tmp = hash(sha2pass: sha2pass, sha2salt: Data(SHA512.hash(data: countSalt)))
            var out = tmp
            if rounds > 1 {
                for _ in 1..<rounds {
                    tmp = hash(sha2pass: sha2pass, sha2salt: Data(SHA512.hash(data: Data(tmp))))
                    for j in 0..<out.count { out[j] ^= tmp[j] }
                }
            }
            let take = min(amount, remaining)
            var i = 0
            while i < take {
                let dest = i * stride + Int(count - 1)
                if dest >= length { break }
                key[dest] = out[i]
                i += 1
            }
            remaining -= i
            count += 1
        }
        return Data(key)
    }

    private static func hash(sha2pass: Data, sha2salt: Data) -> [UInt8] {
        var state = Blowfish()
        let pass = [UInt8](sha2pass), salt = [UInt8](sha2salt)
        state.expand(salt: salt, key: pass)
        for _ in 0..<64 {
            state.expand(key: salt)
            state.expand(key: pass)
        }
        var words = [UInt32](repeating: 0, count: 8)
        let magic = Array("OxychromaticBlowfishSwatDynamite".utf8)
        var at = 0
        for i in 0..<8 { words[i] = Blowfish.streamWord(magic, &at) }
        for _ in 0..<64 {
            var j = 0
            while j < 8 {
                (words[j], words[j + 1]) = state.encrypt(words[j], words[j + 1])
                j += 2
            }
        }
        var out = [UInt8](repeating: 0, count: 32)
        for i in 0..<8 {
            out[4 * i + 3] = UInt8((words[i] >> 24) & 0xff)
            out[4 * i + 2] = UInt8((words[i] >> 16) & 0xff)
            out[4 * i + 1] = UInt8((words[i] >> 8) & 0xff)
            out[4 * i] = UInt8(words[i] & 0xff)
        }
        return out
    }
}

struct Blowfish {
    var p = BlowfishTables.p
    var s = BlowfishTables.s

    static func streamWord(_ data: [UInt8], _ at: inout Int) -> UInt32 {
        var word: UInt32 = 0
        for _ in 0..<4 {
            if at >= data.count { at = 0 }
            word = (word << 8) | UInt32(data[at])
            at += 1
        }
        return word
    }

    private func f(_ x: UInt32) -> UInt32 {
        let a = s[Int(x >> 24)], b = s[256 + Int((x >> 16) & 0xff)]
        let c = s[512 + Int((x >> 8) & 0xff)], d = s[768 + Int(x & 0xff)]
        return ((a &+ b) ^ c) &+ d
    }

    func encrypt(_ left: UInt32, _ right: UInt32) -> (UInt32, UInt32) {
        var l = left, r = right
        l ^= p[0]
        var i = 1
        while i <= 16 {
            r ^= f(l) ^ p[i]
            l ^= f(r) ^ p[i + 1]
            i += 2
        }
        r ^= p[17]
        return (r, l)
    }

    /// Blowfish_expandstate: the key schedule with the salt mixed in.
    mutating func expand(salt: [UInt8], key: [UInt8]) {
        var at = 0
        for i in 0..<18 { p[i] ^= Blowfish.streamWord(key, &at) }
        var l: UInt32 = 0, r: UInt32 = 0
        var saltAt = 0
        var i = 0
        while i < 18 {
            l ^= Blowfish.streamWord(salt, &saltAt)
            r ^= Blowfish.streamWord(salt, &saltAt)
            (l, r) = encrypt(l, r)
            p[i] = l
            p[i + 1] = r
            i += 2
        }
        i = 0
        while i < 1024 {
            l ^= Blowfish.streamWord(salt, &saltAt)
            r ^= Blowfish.streamWord(salt, &saltAt)
            (l, r) = encrypt(l, r)
            s[i] = l
            s[i + 1] = r
            i += 2
        }
    }

    /// Blowfish_expand0state: the key schedule alone.
    mutating func expand(key: [UInt8]) {
        var at = 0
        for i in 0..<18 { p[i] ^= Blowfish.streamWord(key, &at) }
        var l: UInt32 = 0, r: UInt32 = 0
        var i = 0
        while i < 18 {
            (l, r) = encrypt(l, r)
            p[i] = l
            p[i + 1] = r
            i += 2
        }
        i = 0
        while i < 1024 {
            (l, r) = encrypt(l, r)
            s[i] = l
            s[i + 1] = r
            i += 2
        }
    }
}
