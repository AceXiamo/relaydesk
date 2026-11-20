import json
import os
import unittest
from unittest.mock import patch, MagicMock

import assistant_chat


class AssistantTests(unittest.TestCase):
    def test_different_intake_questions(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIn("哪一步", assistant_chat.intake_reply("上传失败"))
            self.assertIn("场景", assistant_chat.intake_reply("建议加标签"))

    def test_private_data_stays_out_of_request(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(assistant_chat, "_provider_reply") as provider:
            provider.return_value = None
            result = assistant_chat.operator_reply(
                {"name": "example", "agent_key": "SECRET"},
                {"owner": "human", "status": "ready", "lease": "SECRET"},
                [{"body": "hello", "other": "SECRET"}], "谁负责？")
            self.assertNotIn("SECRET", json.dumps(provider.call_args.args[1]))
            self.assertIn("负责人为「你」", result)

    def test_public_model_requires_opt_in(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(assistant_chat, "_provider_reply") as provider:
            assistant_chat.intake_reply("加载很慢")
            provider.assert_not_called()

    def test_provider_protocol(self):
        with patch.dict(os.environ, {"RELAYDESK_AI_BASE_URL": "http://127.0.0.1:7272/v1",
                                     "RELAYDESK_AI_MODEL": "local"}, clear=True), patch.object(
                                         assistant_chat, "build_opener") as factory:
            reply = MagicMock()
            reply.read.return_value = json.dumps({"choices": [{"message": {"content": "模型回答"}}]}).encode()
            factory.return_value.open.return_value.__enter__.return_value = reply
            self.assertEqual(assistant_chat.intake_reply("错误"), "发生问题前，你最后做了哪一步？当时页面上显示了什么？")
            self.assertEqual(assistant_chat.operator_reply({}, {}, [], "问题"), "模型回答")
            req = factory.return_value.open.call_args.args[0]
            self.assertEqual(req.full_url, "http://127.0.0.1:7272/v1/chat/completions")
            self.assertEqual(json.loads(req.data)["model"], "local")
