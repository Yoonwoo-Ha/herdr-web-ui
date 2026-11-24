#![cfg(target_os = "linux")]

mod common;

use common::*;
use serde_json::json;

#[test]
fn delivery_is_reported_to_the_sender_before_a_held_turn_finishes() {
    let root = Root::new("delivery");
    let _keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(7, &session, "hold"));
    client.send(&prompt(8, &session, "echo barrier"));
    let row = client.wait("the held prompt receipt or the next reply", |r| {
        method(r) == Some("_keeper/delivered") || (r["dir"] == "to-client" && r["msg"]["id"] == 8)
    });
    assert_eq!(method(&row), Some("_keeper/delivered"));
    assert_eq!(row["msg"]["params"]["id"], json!(7));
}
