import { test } from "node:test";
import assert from "node:assert/strict";
import { isDisposableEmail, normalizeEmail } from "@/lib/security/email";

test("gmail: pontos, +alias e googlemail viram a mesma identidade", () => {
  assert.equal(normalizeEmail("A.B.C+promo@Gmail.com").normalized, "abc@gmail.com");
  assert.equal(normalizeEmail("abc@googlemail.com").normalized, "abc@gmail.com");
  assert.equal(normalizeEmail("  a.b.c@gmail.com ").normalized, "abc@gmail.com");
});

test("outros provedores: só o +alias é removido, pontos são mantidos", () => {
  assert.equal(normalizeEmail("joao.silva+x@outlook.com").normalized, "joao.silva@outlook.com");
});

test("domínios descartáveis são detectados e provedores comuns não", () => {
  assert.equal(isDisposableEmail("mailinator.com"), true);
  assert.equal(isDisposableEmail("gmail.com"), false);
});
