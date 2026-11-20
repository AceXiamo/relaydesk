import unittest
from integrations.telegram import capture


class TelegramCaptureTests(unittest.TestCase):
    def setUp(self):
        self.message = {
            "message_id": 42, "chat": {"id": -900, "type": "supergroup"},
            "from": {"id": 123, "username": "reporter"}, "text": "/feedback@RelayBot 导出少了一行",
        }

    def extract(self, **updates):
        return capture({**self.message, **updates}, {-900}, "relaybot")

    def test_only_explicit_authorized_commands(self):
        for kwargs in [{"text": "群里随便聊聊"}, {"text": "/feedback@anotherbot 页面白屏"},
                       {"chat": {"id": -901, "type": "supergroup"}},
                       {"chat": {"id": -900, "type": "private"}}, {"from": {"is_bot": True}}]:
            with self.subTest(kwargs=kwargs):
                self.assertIsNone(self.extract(**kwargs))

    def test_capture_and_retries(self):
        ticket, _ = self.extract()
        self.assertEqual(ticket["body"], "导出少了一行")
        self.assertEqual(self.extract()[0]["external_id"], ticket["external_id"])
        self.assertNotIn("source_url", ticket)
        self.assertNotIn("reporter", str(ticket))

    def test_multiple_replies_to_same_feedback(self):
        kwargs = {"reply_to_message": {"message_id": 17, "caption": "移动端无法点开菜单"}}
        ticket, _ = self.extract(text="/feedback 补充是 Safari", **kwargs)
        retry, _ = self.extract(text="/feedback", message_id=60, **kwargs)
        self.assertEqual(ticket["external_id"], retry["external_id"])
        self.assertIn("移动端无法点开菜单", ticket["body"])
        self.assertIn("补充是 Safari", ticket["body"])

    def test_public_source_and_empty_guidance(self):
        public_chat = {"id": -900, "type": "supergroup", "username": "productgroup"}
        ticket, _ = self.extract(chat=public_chat)
        self.assertEqual(ticket["source_url"], "https://t.me/productgroup/42")
        ticket, guidance = self.extract(text="/feedback")
        self.assertIsNone(ticket)
        self.assertTrue(guidance)


if __name__ == "__main__":
    unittest.main()
