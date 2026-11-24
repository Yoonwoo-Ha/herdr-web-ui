# The signed list: an entry

No released part of Ovis reads or writes this format yet: the account as it works today signs its
records one by one, with no chain ([Linking devices with an account](account.md#rules)).

An owner's devices and machines share one signed list. Every member keeps a copy and checks every
entry by itself; the account service stores entries and must never be able to write one that
members accept. This page says how one entry is written, signed, hashed and chained, and how a
member checks it. Who may sign an entry (the signers) is checked on top of this and is not part of
this page. The code is [`shared/account-list-entry.ts`](../shared/account-list-entry.ts); the
vectors are in [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope).
The page ends with the [join line](#the-join-line), the one line a machine is given to join an
account, and with how [an invite is a key](#an-invite-is-a-key).

## The form

An entry is two byte strings, a **body** and a **signature**. The body is what is signed, hashed,
stored and sent; nobody re-encodes an entry, so two members never differ over its bytes. A body is
never read or written through JSON.

```
body  = "ovis-list/1" field field ...       at most 8192 bytes in all
field = len(name) name len(value) value     len(x) = the number of bytes of x, as 4 bytes, big-endian
name  = 1 to 32 bytes: the first is a-z, each other is a-z or _
value = 0 or more bytes
```

- Names ascend strictly, compared byte by byte: no name comes twice, and a name that is the start
  of another comes before it.
- The body ends exactly after its last field. A body cut inside a length, a name or a value, or
  with bytes after its last field, has not this form.
- 8192 bytes is the one size limit of an entry: no member takes a longer body.

Seven fields are in every entry, three more may be, and every other field belongs to the entry's
kind: for such a field only the name is checked, never the value.

| name | in | value |
|---|---|---|
| `issued_at` | every entry | when it was signed, by the signer's clock: seconds since 1970-01-01 UTC, a number |
| `kind` | every entry | 1 to 32 bytes in the form of a name |
| `list` | every entry | the list id; empty in entry 0 |
| `prev` | every entry | the hash of the entry before; empty in entry 0 |
| `seq` | every entry | the entry's place, counted from 0, a number |
| `signer` | every entry | the signer's key |
| `v` | every entry | the level that first defined this kind in this form, a number from 1 |
| `adds`, `power` | together or not at all | a key that becomes a signer, and its power: `full` or `bound` |
| `ends` | or absent | a key that stops being a signer |

- A **key** is a P-256 public key: 122 characters of `A-Z a-z 0-9 - _`, the base64url (no
  padding) of 91 bytes, in its one spelling (decoding and encoding again gives the same 122
  characters). The 91 bytes are `3059301306072a8648ce3d020106082a8648ce3d03010703420004` (hex)
  and the point's X and Y. Keys are compared as these 122 bytes. A point that is not on the curve
  (X or Y not below p, or Y² not X³ - 3X + b mod p) is a key in form that signs nothing.
- A **number** is 1 to 15 digits `0-9`, with no sign and no leading zero (zero is `0`).
- A **hash** is 64 characters `0-9a-f`.

A body lacks the form when one of the seven fields is missing, when a value is not in the form the
table names (`v` `0`, a `power` that is neither `full` nor `bound`, an `adds` or `ends` that is no
key, a `list` or `prev` that is neither a hash nor empty), or when `adds` stands without `power`
or `power` without `adds`. Whether a key may stand in `adds` or `ends` is not a question of form.

## The signature, the hash and the list id

- The **signature** is ECDSA P-256 with SHA-256 over the body, under `signer`: `r || s`, 64 bytes.
  Any `r` and `s` from 1 to n-1 that verify count, an `s` above n/2 included. A `signer` whose
  point is not on the curve verifies nothing; the library judges that, like the range of `r` and
  `s`, before it asks the runtime, so that no runtime's way of refusing a key decides. What the
  runtime then throws, and a runtime with no WebCrypto at all (a page on plain http at a LAN
  address), is a fault, never a verdict on the entry.
- The **entry hash** is SHA-256 over `ovis-list-entry/1` and the body, as a hash. It covers the
  body only, so two entries are the same entry when their hashes are equal, whatever their
  signatures. Where `r || s` verifies, `r || n-s` verifies too, and anyone can write it without
  the key, so one body can come with two signatures and as two texts: nothing may identify an
  entry by its signature bytes or its text, only by its entry hash.
- The **list id** is the hash of entry 0.

## On the wire and in files

An entry is one text: the base64url of its body, `.`, and the base64url of its signature, each
without padding in its one spelling, and nothing else; the signature part is 86 characters. Inside
JSON it is a JSON string. A text with no dot or a second dot, an empty part, a character outside
`A-Z a-z 0-9 - _` (padding, white space, a trailing newline), a signature part of another length,
or a second spelling of either part is refused. The body it carries is then checked as above.

## When an entry holds

Entry n holds when, in this order:

1. its body has the form above;
2. its `seq` is n; for entry 0, `list` and `prev` are empty and it carries no `adds` and no `ends`;
   for a later entry, `list` is the list id and `prev` is the hash of entry n-1;
3. its signature verifies.

The check needs the list id and the entry before, and nothing else. A member that was given a list
id (by an offer or a join line) takes as entry 0 only the entry with that hash. An entry that does
not hold stops the member with the code of the first check that fails:

| code | when |
|---|---|
| `entry_malformed` | 1: the body, the text or the signature's 64 bytes have not the form |
| `chain_broken` | 2: a wrong `seq`, `prev` or `list`, an entry of another list, an entry 0 with a `list`, a `prev`, `adds` or `ends` |
| `signature_invalid` | 3: the signature does not verify: a changed byte, a signature by another key, an `r` or `s` outside 1 to n-1, a `signer` whose point is not on the curve |
| `list_mismatch` | an entry 0 that holds but is not the one with the list id the member was given |

## Levels

A level is a number from 1; a build of level L reads every form of levels 1 to L. Each kind writes
in `v` the level that first defined it in that form. Level 1 is five kinds, each written with `v`
1: `genesis`, `device`, `invite`, `join` and `remove`. What each kind carries and means is not part
of this page.

## The join line

A machine joins an account by an invite. The device that makes the invite shows one line, once, and
the machine is given that line. The code is
[`shared/account-list-join.ts`](../shared/account-list-join.ts); the vectors are in
[`shared/account-list-vectors/join/`](../shared/account-list-vectors/join).

```
line = "ovis-join:1:" base64url(json)       at most 1024 characters in all
json = {"v":1,"service":S,"account":A,"list":L,"secret":K}
```

| member | value |
|---|---|
| `v` | the number `1` |
| `service` | the account service's origin, as the URL standard serializes the origin of an `https` URL: `https://host` or `https://host:port`, the host in lower case, with no default port, path, query, fragment or user. A text is in this form when parsing it as a URL and serializing that URL's origin gives the same text back |
| `account` | the id of the account the invite is for: 1 to 64 of `A-Z a-z 0-9 _ -`. It is not secret: a machine shows it and asks before it joins |
| `list` | the list id, or the empty text while the account has no list |
| `secret` | the invite's P-256 private key: the base64url (184 characters) of its PKCS8 in one fixed form of 138 bytes, which holds the public point too |

- The line has one form. The JSON is those five members in that order, written as `JSON.stringify`
  writes them, with no white space; the base64url has no padding and is in its one spelling. A
  reader writes the line again from what it read and refuses a line that differs (`not_one_form`).
- A reader refuses with the code `line_malformed` and one reason. For a line that is not in its
  form: `prefix`, `length`, `base64url`, `json`, `members`, `version`, `service`, `account`, `list`,
  `secret`, `scalar` (a private value not from 1 to n-1) or `not_one_form`. For a line in its form
  that the reader's caller must not act on: `other_service` or `needs_lists`. The line carries a
  private key, so no refusal holds any part of it.
- **A line's `service` is never a destination.** A reader is told the account service its caller
  already uses (the build's, or the one the PC is set to: production, staging or a self-hosted one)
  and takes only a line whose `service` is that service's origin; any other is refused
  (`other_service`) before anything is sent anywhere. The two are compared as text, after the
  caller's own is parsed as a URL and its origin serialized: the scheme, the host and the port
  count, and a path does not. So a line somebody else made cannot send a machine's proof or its
  listing to an origin of their choosing. What `service` is for, then: it binds the line to one
  service, so that a line made for one (staging, say) is no line at another, and it is the service
  whose entries the list's `invite` and `join` will be placed at.
- **A caller that does not follow lists is given no line that names a list** (`needs_lists`): the
  list id says the account has a signed list, and joining it on the service's word alone would undo
  what the list is for.
- A line that reads gives the service, the account, the list id (or none) and the invite's public
  key as [a key](#the-form). It gives no private key: it signs the one message a machine redeems
  an invite with ([An invite is a key](#an-invite-is-a-key)), for the line's own account and
  nothing a caller composes, and it holds the secret once more as a key that only agrees on a
  shared secret (ECDH), which opens what was encrypted to the invite's key. Neither can be
  exported.
- No released build wrote a line before the account was in it, so there is one form and one
  version. A line without `account` is refused (`members`).

## An invite is a key

An invite is a P-256 key pair. The code is
[`shared/account-list-invite.ts`](../shared/account-list-invite.ts); the vectors are in
[`shared/account-list-vectors/invite/`](../shared/account-list-vectors/invite).

- The **device** makes the key pair, gives the account service the public key alone, as
  [a key](#the-form), and writes the line. It keeps nothing: the line is the only copy of the
  private key.
- The **account service** stores the public key and never sees the private key or the line. So it
  cannot use an invite, and it cannot sign for one. This is about what an invite is worth, not
  about who is in an account: until an account has a signed list, the service admits a PC on its
  own word, with an invite or without one.
- The **machine** that joins proves it holds the line: it signs these bytes with the line's private
  key, and sends the invite's public key and the signature.

```
bytes = "ovis-invite-redeem/1" len(account) account len(server_id) server_id
        len(public_key) public_key len(challenge_id) challenge_id
len(x) = the number of bytes of x, as 4 bytes, big-endian
```

| value | |
|---|---|
| `account` | the account's id, as in the line |
| `server_id` | the machine's id: 32 of `0-9a-f` |
| `public_key` | the machine's relay key: 64 of `0-9a-f` |
| `challenge_id` | the id of the account service's challenge that the machine's own proof answers in the same request: 32 of `0-9a-f` |

- The signature is ECDSA P-256 with SHA-256 over those bytes, `r || s`, sent as 86 characters of
  base64url with no padding, in its one spelling. It is checked as an entry's signature is: any `r`
  and `s` from 1 to n-1 that verify count, and a key whose point is not on the curve verifies
  nothing.
- The service finds the invite by its public key and checks the signature with the account that
  invite belongs to. The bytes name the account, the machine and one challenge, which the service
  uses up, so a signature that was seen once joins nothing else.
- What the service learns at a redeem: the invite's public key (which it has), the signature, and
  the machine's id, relay key and challenge id, which the machine's own proof gives it too. A
  redeem signature counts nowhere else: no entry and no other proof starts with its bytes.
- These are values and lengths with no names, as in the other proofs a device or a machine signs
  for the account service; an entry's body has named fields.

A device whose sign-in is older than ten minutes proves its registered key when it makes an invite,
as it does when it adds a PC ([Linking devices with an account](account.md#rules)). What it signs
names the invite's public key, so a proof made for one invite registers no other:

```
bytes = "ovis-pc-add/1" len(purpose) purpose len(account) account len("") "" len(invite_key) invite_key
        len(challenge_id) challenge_id len(challenge) challenge
```

`purpose` is `invite`, or `invite-auto` for an invite a machine joins with by itself; the empty
value stands where a PC's id stands in the other proofs of this form, and `invite_key`, the
invite's public key as [a key](#the-form), where a listing id does.

## The vectors

Each file of [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope) is
one JSON object: `name`; `given_list`, only when the member was given a list id; `keys`, the test
keys (base64url `pkcs8` and `spki`, each named `TEST-ONLY-...`: never use them outside tests);
`entries`, in order, each with `fields` (the body's fields as text, for a reader), `body` and
`signature` (base64url), `text` (the entry on the wire, which is what a reader reads) and `hash`;
and `expect`: either `state` (`{ list, head: { seq, hash }, first_signer }` after the last entry)
or `stops` (`{ seq, code }`: the place of the entry that does not hold and its code). Every `text`
that reads is `body`, `.`, `signature`; the `wire-` vectors carry a `text` that does not read,
beside the entry it was made from. ECDSA signatures are random, so a vector fixes the body, the
hash and one signature to verify; nobody is asked to reproduce a signature. Two implementations
agree on this page when both give every vector's `expect`.

Each file of [`shared/account-list-vectors/join/`](../shared/account-list-vectors/join) has `name`,
`keys`, a `line` and `expect`: either what the line reads to (`service`, `account`, `list`, which is
`null` for an account with no list, and `key`) or `stops` (`{ code, reason }`). A `reader`
(`{ service, follows_lists }`) says what the reader is told of its caller; without one the caller
uses `https://accounts.ovis.test` and follows lists. Each `redeem` file of
[`shared/account-list-vectors/invite/`](../shared/account-list-vectors/invite) has `name`, `keys`,
the `line`, the `key` the signature is checked under (the key the line reads to, but for the two
files that change it, which name that one as `key_of_line`), the `redeem` values, a `signature`,
and `expect.verifies`; every file whose values are in form (all but `redeem-server-id-uppercase`)
has their `bytes` (base64url) and `bytes_hex`. Each `make-proof` file has the `make` values, their
`bytes`, the device's key as `device_key`, and a `signature` by it.
