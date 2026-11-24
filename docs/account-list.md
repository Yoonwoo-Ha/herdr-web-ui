# The signed list: an entry

No released part of Ovis reads or writes this format yet: the account as it works today signs its
records one by one, with no chain ([Linking devices with an account](account.md#rules)).

An owner's devices and machines share one signed list. Every member keeps a copy and checks every
entry by itself; the account service stores entries and must never be able to write one that
members accept. This page says how one entry is written, signed, hashed and chained, and how a
member checks it. Who may sign an entry (the signers) is checked on top of this and is not part of
this page. The code is [`shared/account-list-entry.ts`](../shared/account-list-entry.ts); the
vectors are in [`shared/account-list-vectors/envelope/`](../shared/account-list-vectors/envelope).
What each kind of entry means, and the state the entries build, is under [The kinds](#the-kinds);
the code for that is [`shared/account-list.ts`](../shared/account-list.ts).
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
in `v` the level that first defined it in that form. Level 1 is nine kinds, each written with `v`
1: `genesis`, `device`, `pc`, `invite`, `join`, `remove`, `carried`, `card` and `epoch`.

## The kinds

The members of a list are **devices** (a phone, a desktop app, a browser) and **PCs**. Every member
has a signing key; a PC is also known by its relay key, the key a device already holds it to when
it connects. An **invite** is a key too. Who may sign an entry is the signers' rule, from `adds`,
`power` and `ends` alone: a signer of power `full` adds and ends any key, one of power `bound` ends
only itself, and a key that was ever a signer is never added again. The kind says what the entry
means on top of that.

| kind | signed by | carries | it means |
|---|---|---|---|
| `genesis` | the first device, as entry 0 | `account`, `enc`, `epoch_opens`; names | the list starts for that account; its signer is the first device, `full`, with role `drive`; epoch 0 is open |
| `device` | a `full` signer | `adds` and `power`; `card`, `enc`, `role`, and `until` or not; names | the key in `adds` is a device with that power and role. With power `full` its role is `drive` and it has no `until` |
| `pc` | a `full` signer | `adds` with power `full`; `card`, `enc`, `endpoint`; names | a person added the PC at that relay key; the key in `adds` is its signing key |
| `invite` | a `full` signer | `adds` with power `bound`; `auto`, `exp`, `uses`; names | the key in `adds` is an invite |
| `join` | an invite's key | `card`, `enc`, `endpoint`, `pc`; names | the PC at that relay key joins by itself; `pc` is its signing key, which is no signer |
| `remove` | see below | `ends`, or `endpoint` | the key, or the PC at that relay key, is out |
| `carried` | the first signer, right after entry 0 | `adds` with power `full`, `role` `drive`; or `endpoint`; names | a device, or a PC, that was in the account before it had a list |
| `card` | a device with no encryption key yet | `enc` | the device names its encryption key |
| `epoch` | a `full` signer | `epoch`, `epoch_link`, `epoch_opens` | the epoch after the current one is open |

"names" is the two fields `sealed` and `epoch`, which come together or not at all: an entry whose
writer holds no key to seal its names with carries neither, and counts all the same.

| field | value |
|---|---|
| `account` | the account's id: 1 to 64 of `A-Z a-z 0-9 _ -` |
| `auto` | `1` for an invite a PC joins with by itself, `0` for one that needs a person to add the PC |
| `card` | a [card](#a-card)'s signature: 86 characters of base64url, `r \|\| s` |
| `enc` | an encryption key: [a key](#the-form) whose point is on the curve |
| `endpoint` | a PC's relay key: 64 of `0-9a-f` |
| `epoch` | a number: the epoch whose key sealed this entry's names; in an `epoch` entry, the epoch that is current where it stands |
| `epoch_link` | 61 bytes: the key of the current epoch, under the key of the epoch the entry opens |
| `epoch_opens` | a hash: the commitment to the key of the epoch the entry opens (epoch 0 in a `genesis`) |
| `exp` | a number, at most `issued_at` + 604800 (7 days after the entry was signed): the invite lets no PC in once a `full` signer has signed an entry at a later time. The account service also judges it against its own clock |
| `pc` | a PC's signing key: a key whose point is on the curve |
| `role` | `drive` (types into terminals) or `watch` (only reads them) |
| `sealed` | the entry's [names](#what-is-sealed), sealed: at least 47 bytes |
| `until` | a number, only with power `bound`: a PC lets the device in only before this second, by the PC's own clock |
| `uses` | a number from 1 to 256: how many PCs may join with the invite |

An entry is of its kind only with exactly those fields, each in its form, and with `adds` and `ends`
only where the table has them. One exception: a `device` may carry `ends` when it names the entry's
own signer, which so hands its place to the key in `adds` in one entry. Anything else is not of its
kind and has no effect of it (`entry_invalid`); its `adds` and `ends` have applied all the same, so
the key it adds is a signer with no name: it may sign what its power allows, and it opens nothing
and is no device and no PC.

What the kinds add to the signers' rule:

- **A PC that a person added is a signer of power `full`**, so a person at that PC can allow a
  device, add a PC and remove a member. It is in while its key is a signer: the entry that ends the
  key puts the PC out, whatever its kind. Its relay key alone does not put it out (`ends_needed`),
  since that would leave its key a signer.
- **Only a `bound` device watches or has an `until`.** A device of power `full` adds whom it likes,
  so a role or an hour would hold it to nothing: a `device` with power `full` and role `watch`, or
  with an `until`, is not of its kind.
- **A PC that joined by an invite is no signer.** A `join` counts only when its signer is an open
  invite with `auto` `1`. Such a PC lets devices in and can allow nobody. An invite with `auto` `0`
  lets no PC in by itself (`invite_not_auto`): the PC asks with its line, and a member's `pc` adds
  it.
- **An invite is open** while its key is a signer, whoever placed it is one, fewer PCs joined with
  it than `uses`, and its time is not over. Otherwise its join takes the first name that applies:
  `invite_unknown`, `invite_revoked`, `invite_void`, `invite_spent`, `invite_expired`.
- **An invite's time is over by the list's own time, and by no reader's clock.** The list's time is
  the latest `issued_at` among the entries that a `full` signer signed and that were not passed
  over. Once it lies after an invite's `exp`, a `join` by that invite has no effect
  (`invite_expired`), whoever places it and whenever. A `join`'s own `issued_at` says nothing: its
  signer is the invite. So whoever finds an old line cannot join with it once any member has
  signed anything since, even where the service places what it is given. A `full` signer that is
  awake past an unused invite's `exp` puts it out (`remove` with `ends`): until one does, the
  holder of the line still reads the names sealed before.
- **A relay key comes in once** (`endpoint_reused`), also after its PC was put out. One row waits
  for more: a carried PC that is still in gets its keys from a person's `pc` at its relay key, and
  never from an invite's `join`. **A PC's key comes in once**, at one relay key: a key that any PC
  ever had here names no other PC, device or invite (`key_reused`). A person's `pc` makes its
  fresh key a `full` signer in that same entry; the `pc` key of an invite's `join` is never one,
  and a key that is or was a signer cannot stand there (`key_reused`).
- **`remove` with `endpoint`** puts out a PC whose key is no signer (one that joined or was
  carried), and only a `full` signer's does (`signer_not_allowed`, then `already_out`). Where the
  key of a PC that joined was made a signer afterwards, the PC goes with its key like one a person
  added: `ends_needed` for its relay key, and the `ends` of the key puts the PC out.
- **`carried`** counts only from the first signer (`signer_not_allowed` from anyone else) and only
  right after entry 0: once a signer has signed anything that is no `carried` that counted, nobody
  is carried in (`carried_late`). It has no card and gives power `full`, so it is how the device
  that starts a list for an account that was in use names who was in it, and no way in afterwards,
  for the first signer or for whoever holds the service. A carried device has no encryption key
  until its own `card` names one, once (`enc_set` after that). A PC that was in the account
  follows such a list only when every device it carries in is one that PC already lets in, all of
  them or none.
- **Names are sealed under the current epoch.** An entry whose `epoch` is another has no effect
  (`epoch_other`): under an earlier key a member that was put out could read the names, and under a
  later one nobody can. Only an `epoch` entry of a `full` signer opens the next epoch, and only when
  it names the current one, so of two members that open it at once one does. A removal opens none
  by itself: whoever puts a member out places an `epoch` entry after the `remove`, and a member
  that signs itself out leaves that to one that stays.
- **A writer seals nothing under an epoch that somebody who is out can read.** It seals under the
  current epoch only when the entry that opened it stands after the last entry that put out a
  device, a PC, or an invite with `auto` `1`, and after the `join` that took such an invite's last
  use (the holder of that line held the key too); and only while no device that is in is past its
  `until` and no such invite that still has a use is past its `exp`, by the writer's clock. One of
  those is first put out and the next epoch opened. Otherwise the writer writes its entry with no
  names. This is the writer's rule (`sealEpoch`), which no writer works out for itself; an entry
  that breaks it still counts.
- **A member judges an entry by no clock of its own but for one thing.** A device with `until` is
  let in only before that second by each PC's own clock, which never reads before the list's own
  time or the time that PC last saved (`listClock`); it stays a signer of its power after it, and
  so can still end itself.

How a member writes follows from this. An entry names the entry before it, so a member knows what
becomes of its own entry on its footing before anybody else sees it. It signs an entry only when
that entry counts on its own state (`signListEntry`): it builds the entry, takes it as every member
will, and signs nothing that would be passed over or have no effect. So no member's own entry
leaves a signer with no name.

Two more rules are for writers alone. The account service holds every writer to them, and a member
counts an entry that breaks one all the same:

- **Nobody opens an epoch at will.** A member writes an `epoch` only where names can no longer be
  sealed under the current one: somebody who may hold its key is out or over its time (`sealEpoch`
  says so). After a removal that is the very next entry, in one batch: the `remove`, or several,
  then one `epoch`. Where a device past its `until` or an invite past its `exp` is still in, it is
  put out first. So an entry that did not get its place, an add say, is signed again on the new
  head and sealed under the same epoch as before: the service kept nothing of the request that did
  not place, the key wrapped for the newcomer included. Should an add be given up for good, a wrap
  for that key exists only at a service that lied about keeping nothing, and it opens names, never
  a way in.
- **An invite a PC joins with by itself is made for one PC**, with `uses` `1`, for as long as the
  account service keeps invites of its own beside the list: a PC first redeems the invite with the
  service, which takes each invite once, so a second PC under one invite is refused there (`403
  not_redeemed`) whatever `uses` says.

What stays true all the same, and what to do about it:

- **A signer with no name can exist**, where an entry by a `full` signer added a key and had no
  effect of its kind: the signers' rule applies `adds` whatever the kind. It opens nothing and is
  no device and no PC, and it signs what its power allows. Every member lists such signers
  (`listView`), so that a person sees one and ends it.
- **A key that lets nobody in any more can still sign.** An invite that is spent, void or over its
  time, and a `bound` device past its `until`, stay signers of power `bound` until they are ended:
  an entry of theirs has no effect and still takes the next place in the list. The account service
  counts what such a key places and stops it.
- **A device that hands its place to a new key** is out with its old key, and the invites it
  placed are void with it: it places them again.
- **Nothing proves an encryption key.** A card says that the holder of a signing key named this
  `enc`; nobody checks that anybody holds its private half. A wrong one costs that member the
  names, and nothing else.
- **The holder of an `auto` line can name a relay key that is not its own in a `join`**, and a
  service that is not honest places it. It gives no way into that PC: a device holds a PC to its
  relay key, which the holder cannot answer for. It costs the PC that relay key in this list (a
  relay key comes in once) and shows the holder the names. The PC comes back as a new PC, with a
  new relay identity and a new add.
- **A level above 1 must give a `bound` key's entry of a higher `v` no effect that lets anybody
  in.** A member of a lower level applies its `ends`, does nothing of its kind, and is not behind
  for it: only a `full` signer's entry that it cannot read makes it so.

A member that reads an entry whose `v` is above its level applies `adds` and `ends` and nothing of
the kind, and from an entry of a `full` signer that it cannot read it is behind: it lets nobody new
in, and still applies every removal. Besides removals, the one thing it takes in is the keys that
a person's `pc` gives a carried PC that is in, and only where that `pc` passes every check it
passes for a member that reads everything. The reason is a sequence: a carried PC is in; the member
falls behind; a `pc` gives that PC its keys; the key is ended. Without the keys the member could
not tell which PC that end means, and would hold a PC that every other member had put out. Nobody
new comes in by this, and no PC moves to another relay key.

One thing a member that is behind cannot follow: which keys PCs that joined after it fell behind
have. A `pc` that names such a key for a carried PC has no effect for a member that reads
everything (`key_reused`), and the member that is behind takes it. No member that signs only what
counts writes such an entry; one that does can leave a member that is behind holding that carried
PC after the others put it out by its relay key, until that member is updated and replays.

### A card

A newcomer has no say in the list before it is in it. So it states what nobody else may choose for
it under its own signature, and the entry that lets it in carries that signature in `card`:

```
bytes = "ovis-list-card/1" and the fields enc, key and list, for a PC endpoint, and for a PC that joins by an invite invite, in the form of a body's fields
```

- `key` is the newcomer's signing key (the `adds` of a `device` or `pc`, the `pc` of a `join`),
  `enc` its encryption key, `list` the list id, `endpoint` the PC's relay key, and `invite` the key
  of the invite that signs the `join`.
- The signature is `key`'s, ECDSA P-256 with SHA-256 over those bytes, checked as an entry's is.
- A `device`, `pc` or `join` whose card is not that of its key, for its `enc`, this list, its
  `endpoint` and its invite, has no effect (`card_invalid`). So nobody can name a key that never
  asked to join, give a member an encryption key that is not its own, move a card to another list,
  or take the card a PC made for a person to add it and join that PC by an invite instead.
- A device that was carried in was not there to sign a card: its `card` entry, signed with its own
  key, says the same.
- When a person adds a PC by comparing a number on two screens, the number is bound to the card:
  its binding is SHA-256 over the card's bytes, and the digits come from that binding and a nonce
  from each end, each fixed before it sees the other's, as pairing by comparing digits does
  ([Relay](relay.md)). Digits of the hash alone
  would prove nothing: whoever carries the card between the two could try keys until one fits.

### What is sealed

A member's name and OS word are not needed to decide who is in, so they are not in the clear: the
entry carries them in `sealed`, encrypted under the key of an epoch, which the members share and
the account service never has. How they are sealed and how members share the keys is under
[Names the service cannot read](#names-the-service-cannot-read). No rule above reads `sealed` beyond its length, or needs a key: so a member that was
given no key to the names, or a wrong one, lets in and puts out exactly whom every other member
does, and so does the account service.

What is sealed is fields in the form of a body's fields: `label`, and `os` when the OS is known.
`label` is a name: 1 to 48 UTF-16 units, no control character, no unpaired surrogate, and of white
space only single spaces inside it. `os` is one of `ios`, `android`, `macos`, `windows`, `linux`,
`chromeos`. A reader takes an OS word it does not know as none and passes by a field it does not
know, so a later build may say more; a field named `pad`, which fills a sealed text up to a fixed
size, is such a field and no name.

An **epoch** is the time one such key is in use. Entry 0 opens epoch 0, and each `epoch` entry
opens the next. What opens an epoch says two things of it in the clear: `epoch_opens`, a commitment
to its key, so that a member takes a key for that epoch from nobody unless it gives this
commitment; and `epoch_link`, the key before under the new one, so that a member given the current
key reads the names of every earlier epoch.

In the clear are the keys, the relay key of each PC, each role and `until`, each invite's `exp`,
`uses` and `auto`, and the epochs' numbers: the account service sees how many devices and PCs an
account has and when each came and went, and not what they are called.

### The state

A member's state is plain data that JSON holds: the signers' state, and beside it

| part | named by | holds |
|---|---|---|
| `account` | | the account the list is of, as entry 0 names it |
| `full_at` | | the list's own time: the latest `issued_at` of an entry a `full` signer signed that was not passed over |
| `carrying` | | whether a `carried` still counts |
| `signers` | key | each signer's row, with `as`: `device`, `pc`, `invite`, or none |
| `devices` | key | `role`, `until`, `enc` (none for a carried device that has not named it), `carried` |
| `pcs` | relay key | `how` (`added`, `joined` or `carried`), `key`, `enc`, `seq`, `invite`, `removed` |
| `pc_keys` | key | the relay key of the PC that has or had this key |
| `invites` | key | `exp`, `uses`, `joins`, `auto` |
| `epoch`, `epochs` | number | the current epoch's number; for each epoch `opens`, `link` (none for epoch 0) and `seq`, the place of the entry that opened it |

Nothing is ever deleted. A device or an invite is in while its key is a signer, and a PC while its
`removed` is empty. A PC lets a device in while the device is in and, when it has an `until`, before
that second, as what its `role` says. The key of an epoch is wrapped to the encryption key of each
device and PC that is in, and to the own key of each open invite with `auto` `1`, so that a PC
which joins with nobody else awake can read the names and seal its own. Whoever wraps leaves out a
device past its `until` and an invite past its `exp`, by its own clock, so that an old line or a
borrowed browser is given no later key; that clock chooses only whom a key is wrapped to, and lets
nobody in and puts nobody out. A member that stopped for a replay answers for nobody until it has
replayed: it lets no device in, holds no PC, lists nothing, takes no invite for open and wraps to
nobody.

A saved state is trusted exactly as far as the member's own storage is. Reading it back checks
that it has its form and agrees with itself, which catches a state that was damaged, not one that
somebody who can write the store wrote with care. A member that starts replays the entries it
kept and holds what the replay gives.

Every entry that holds comes to one of these, the same for every member of one level and for the
account service:

| outcome | when |
|---|---|
| `passed_over` | the signers' rule passes it over: nothing in it applies (`signer_unknown`, `signer_not_allowed`, `key_reused`, `already_out`; a `join` takes its invite's name) |
| `stops` | a member that is behind cannot place it, and takes nothing until it replays (`needs_replay`) |
| `cannot_read` | its `v` is above the member's level: `adds` and `ends` have applied, the kind does nothing |
| `no_effect` | `adds` and `ends` have applied, and the kind does nothing, by the first of: `entry_invalid`; `epoch_other`; what the list holds (`invite_unknown`, `invite_revoked`, `invite_void`, `invite_spent`, `invite_expired`, `invite_not_auto`, `signer_not_allowed`, `already_out`, `ends_needed`, `endpoint_reused`, `key_reused`, `enc_set`, `carried_late`); `card_invalid` |
| `counts` | the kind's rule counts it |

### Reading the log with an invite

A machine that holds a join line is no member yet and still has to read the log. It proves that it
holds the invite: `ovis-list-read/1` and the fields `after` (the place its page follows, or empty
for the start), `at` (when it was made), `key` (the invite's key) and `list`, in the form of a
body's fields, signed with the invite's key and written as one text like an entry. The account
service checks the form (`proof_malformed`), then the signature (`signature_invalid`), then what
the list holds of that invite, and judges `at` and the invite's `exp` by its own clock.

## Names the service cannot read

The account service stores the list and must not read the names in it: a device's label, a PC's
address, an operating system. A kind puts those fields into one field, `sealed`, encrypted under
the list's current **epoch key**, and every member holds that key **wrapped** to an encryption key
of its own. The service keeps the wraps beside the list and can open none of them.

Nothing of this section is part of when an entry holds, and who is a member never depends on it: a
wrap or a sealed field that does not open hides a name, and nothing else. Which fields a kind seals
and what it calls the clear fields named below belongs to the kinds. The code is
[`shared/account-list-seal.ts`](../shared/account-list-seal.ts); the vectors are in
[`shared/account-list-vectors/seal/`](../shared/account-list-vectors/seal).

```
number(n) = n as 8 bytes, big-endian            a seq or an epoch: 0 to 999999999999999
id(list)  = the 32 bytes the list id spells     for entry 0, which has no list id yet: 32 zero bytes
key(k)    = the 91 bytes a key spells
HKDF(secret, info, n) = HKDF with SHA-256, a salt of 32 zero bytes, n bytes out
GCM(key, nonce, data, text) = AES-256-GCM, a 12-byte nonce: the ciphertext, then the 16-byte tag
```

A wrap, a link and a sealed field each start with a version byte, `0x01`. A new version byte comes
with new tag strings (`ovis-list-wrap/2` and so on), so no bytes of one version open as another's.

### The keys

- A member's **encryption key** is a P-256 key used for ECDH, written as a key. A device makes it
  in WebCrypto so that it cannot be exported and keeps it in IndexedDB. A PC keeps its private key
  in a file, as the base64url of the 138-byte PKCS8 form a join line's secret has.
- An **epoch key** is 32 random bytes. Epochs count from 0: entry 0 opens epoch 0, and after a
  member is removed an entry opens the next. An entry with a `sealed` field says in clear which
  epoch it is sealed under.
- The **commitment** to an epoch key is
  `SHA-256("ovis-list-epoch-key/1" || id(list) || number(epoch) || key)`, as a hash. The entry that
  opens an epoch carries it in clear, under its signature. A member takes an epoch key, from a
  wrap or from a link, only when it gives the commitment the list holds for that epoch. Without
  this the service, which can wrap any key to any member, could hand a new member a key of its own
  and read what that member seals.
- The commitment to the key of epoch 0 stands in entry 0, whose hash is the list id, so no list id
  can be part of it: there `id(list)` is 32 zero bytes, and the commitment binds its own tag, the
  epoch number 0 and the key. What binds it to its list is entry 0 itself: the list id is the hash
  of the body that carries it. Every later commitment binds the list id too.

### A wrap

An epoch key for one member, made by any member that holds the key. It is stored at the service,
never in the list.

```
wrap   = 0x01 X Y GCM(k, n, no data, epoch key)       113 bytes: 1 + 32 + 32 + 32 + 16
X Y    = the point of a P-256 key made for this wrap alone (the ephemeral key)
k n    = HKDF(shared, "ovis-list-wrap/1" || id(list) || number(epoch) || key(member) || key(ephemeral), 44)
shared = the X of ECDH between the ephemeral key and the member's key, 32 bytes
```

`k` is the first 32 bytes and `n` the last 12. On the wire a wrap is 151 characters of base64url
without padding, in its one spelling. A wrap of another length, with another first byte, or whose
point is not on the curve has not the form.

### A link

Each epoch key also encrypts the one before, so a member given the current key reads every earlier
epoch. The entry that opens epoch e carries the link to epoch e-1 beside its commitment.

```
link = 0x01 nonce GCM(HKDF(key of e, "ovis-list-epoch-link/1", 32), nonce, data, key of e-1)      61 bytes
data = "ovis-list-epoch-link/1" || id(list) || number(e)
```

A member walks back one link at a time and checks each key against its commitment. One walk opens
at most 1024 links; a longer history is walked on from the last key reached. The key the walk
starts from is checked against the commitment of its own epoch too.

### A sealed field

```
sealed    = 0x01 nonce GCM(HKDF(epoch key, "ovis-list-seal/1", 32), nonce, data, plaintext)
data      = "ovis-list-seal/1" || id(list) || number(seq) || number(epoch)
plaintext = "ovis-list-sealed/1" field field ...
```

- `list`, `seq` and the epoch are the entry's own, so a sealed field opens only at the place it
  was sealed for: that list, that `seq`, that epoch. It is bound to the place, not to one entry.
  When two entries are written for one place (two members reach for the same `seq`), the sealed
  field of either opens in the other. Which body stands at a place is said by the entry's
  signature and the chain, which cover the bytes of `sealed` like every other field.
- The plaintext's fields have the form of an entry's fields: lengths of 4 bytes, names ascending.
  A sealed field is the plaintext and 29 bytes, and at most 8192 bytes.
- A writer fills the plaintext up to 256 bytes, or to the next multiple of 256 when it is longer,
  with one more field, `pad`, of zero bytes. So a sealed field is 285 bytes whatever short names
  it holds. `pad` is no name of any kind: no kind writes it, and a reader drops it whatever it
  holds. A reader also reads a plaintext that is not filled.
- A member seals only under a key that gives the commitment the list holds for its epoch, the
  same check as when it took the key.
- The nonce is 12 random bytes. It is never made from `seq`: a member whose entry n lost its place
  signs another entry n, with other fields, and a nonce made from `seq` would come twice under one
  key.
- The bound of one epoch key counts sealings, not entries: every time any member seals a field
  under that key, for an entry that got its place, for one that lost it to another member's, and
  for every new try. Among n sealings under one key the chance that two nonces are equal is under
  n² / 2^97, and it stays under 2^-32 up to 2^32 sealings. For a sense of the size: the account
  service takes at most 16384 entries into one list; with every one of them sealed under one key
  and a thousand sealings for each, the chance is under 2^-49.
- The epoch key never encrypts by itself: fields and links each use a key of their own made from it.
- An epoch key belongs to one list and one epoch. It is never used for another list or made the
  key of another epoch.

### Who seals, and when

The library sees no list, so these are rules for the member that writes an entry.

- A member seals only under the list's current epoch, and only when the entry that opened that
  epoch comes after the last entry that took a key out of those the epoch key is wrapped to: an
  entry that ends a device's, a PC's or an invite's key (a revoked invite too), or that removes a
  PC by its address. Otherwise it seals nothing and writes its entry without names. Sealed under
  any other key, the names would be read by a member already removed.
- So after a removal nothing is sealed until a member that stays has opened the next epoch. The
  remover places both entries in one request. Where it cannot (a device that signs itself out
  cannot make the key for those that stay), the entries written meanwhile carry no names.
- An epoch that the member being removed opened itself just before its removal does not count: its
  opening entry comes before the removal, and that member holds its key. A member that stays
  opens another.
- What remains: a member from which the service withholds the removal itself does not know of it
  and still seals under the old key, which the removed member holds. Nothing in the list stops a
  service from withholding entries; the harm is bounded to the names written by members that have
  not yet seen the removal.

### A removal, an addition

- After a removal a member that stays makes the next epoch key, puts its commitment and its link
  into the entry that opens the epoch, and gives the service a wrap for every member that stays,
  in the same request. What was sealed before stays readable to the removed member, its own
  removal included; its key and its old wraps open nothing sealed under the new key.
- Every attempt to open an epoch makes a new key. A key whose wraps went out in a request that did
  not place its entry is never used again: by the next attempt the members that stay may be
  others.
- A member that adds another wraps the current epoch key to it, in the request that places the
  entry. If that request does not place the entry, the member signs the entry again on the new
  head and goes on under the current epoch; it opens no epoch for that. The service keeps nothing
  of a request that does not place, the wrap included. If the addition is given up for good, a
  wrap for a key that never became a member's exists only at a service that kept it against this
  rule: it opens names, until the next removal moves the epoch, and never a way in.
- A member whose encryption key is not a point of the curve gets no wrap; the removal or the
  addition goes on without it.

### What the service still learns

The service reads no name. It does see, of every list:

- which entries carry names and under which epoch, and when each epoch opens;
- the length of each sealed field, which is the length of its plaintext and 29 bytes. Filled, a
  plaintext is 256 bytes unless its names are long: then the service learns in which multiple of
  256 bytes they end;
- the encryption key of every member, which key each wrap of each epoch is for, and so which
  member has no wrap;
- everything an entry says in clear.

### What does not open

Opening never fails with an error. It gives the key or the fields, or one of these, and the device
or PC is then shown without its name:

| why | when |
|---|---|
| `missing` | no wrap, link, key or sealed field was given |
| `form` | a wrong length, another first byte, a point not on the curve, a plaintext that is no fields, a place that is none (a list id with seq 0, none with a later seq) |
| `refused` | in form, but the tag does not hold: another member's wrap, another list, seq or epoch, another key, a changed byte |
| `other_key` | a wrap or a link that opens, to a key that is not the one the list commits to. The name is hidden like any other, and the member also says so, because this is no lost or stale wrap. From a wrap it means the account service gave a wrong key: the service stores the wraps, and this is a sign of tampering. From a link it means the member that signed the entry which opened that epoch wrote a wrong link: the link is in the signed list, not the service's to change |
| `bound` | the walk back opened as many links as one walk may |
| `unavailable` | the runtime could not do it (no WebCrypto on a page on plain http): a fault of the place, not a verdict on the bytes |

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
  key as [a key](#the-form). It gives no private key. It signs three things and nothing a caller
  composes: the message a machine redeems an invite with ([An invite is a key](#an-invite-is-a-key)),
  for the line's own account; a `join` entry of its own key on its own list that adds no key and
  ends none, which a PC builds from its own keys and never from what it was sent; and the proof by
  which its holder reads its own list ([Reading the log with an invite](#reading-the-log-with-an-invite)).
  And it holds the secret once more as a key that only agrees on a shared secret (ECDH), which
  opens what was encrypted to the invite's key. Neither can be exported.
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

Each file of [`shared/account-list-vectors/kinds/`](../shared/account-list-vectors/kinds) is a list
from entry 0: `name`, `level` (the member's), `keys`, `entries` as above (`sealed` is shown as
base64url), and `expect`: either `outcomes` (what became of each entry after entry 0, as
`counts`, `cannot_read`, or the outcome and its name) with the whole `state` after the last entry,
or `stops`. A list that no member follows has `stops` alone; a member that stopped after entries
it took (at one that does not hold, or at one it cannot place) has `stops` with the `outcomes` and
the `state` of what it kept. [`card/`](../shared/account-list-vectors/card) holds cards (`card`,
its `bytes` where it is in form, a `signature`, `expect.holds`) and [`names/`](../shared/account-list-vectors/names)
holds names (`fields`, each a name and its value as base64url, and `expect.names`, which is `null`
for fields that give none; `written` says that a writer writes exactly those fields for those
names).

### The vectors of seal/

Each file of [`shared/account-list-vectors/seal/`](../shared/account-list-vectors/seal) is one JSON
object with a `name`, an optional `note`, one of `wrap`, `link` and `sealed`, and `expect`.

- `wrap`: `list`, `epoch`, `commitment`, `member` (a name in `keys`, the test keys as above) and
  `text`, the wrap on the wire. A `text` that does not read has not the form.
- `link`: `list`, `from` (`epoch` and its `key`, 64 hex digits), `commitment` (of the epoch before)
  and `bytes` (base64url).
- `sealed`: `list` (empty for entry 0), `seq`, `epoch` (`epoch` and its `key`) and `bytes`.
- `expect` is `{ key }` (the epoch key that comes out, 64 hex digits), `{ fields }` (the names and
  their values, as text, without `pad`) or `{ why }`, one of the codes above.

Wraps, links and sealed fields are made with random bytes, so a vector fixes one to open; nobody is
asked to make the same bytes again. The `-made-elsewhere` vectors were written by a second
implementation, which also reads every vector in the tests with readers of its own (its base64url,
its field form, its key prefix). The `-made-in-python` vectors (a wrap, a wrap of epoch 0 with its
commitment, a link and a filled sealed field) were written once by a Python script that shares no
code with either, using `hashlib` and the `cryptography` library; the same script read every other
vector and gave its `expect`. Devices use WebCrypto with a key that
cannot be exported, so [`scripts/account-list-seal-browser-qa.ts`](../scripts/account-list-seal-browser-qa.ts)
reads every vector in a real browser too.
