/**
 * This page's copy of its account's signed list (accountList.ts): one for every part of the app. The hosted shell
 * makes it and reads it on its clock (relay/accountController.ts); a card that lets a device in signs with it. None
 * on a page that follows no list: a PC's own page, a test that gives its own stores.
 */
import type { AccountList } from "./accountList.ts";

let page: AccountList | null = null;

export function pageAccountList(): AccountList | null {
  return page;
}

export function setPageAccountList(list: AccountList | null): void {
  page = list;
}
