# Run: python build.py <this folder>, with the onnx 1.19.1 and tokenizers 0.22.1 packages.
# Builds a tiny BERT-shaped embedding model and WordPiece tokenizer for tests.
# The model: last_hidden_state[b, s, :] = [sin(.1 id), cos(.1 id), sin(.37 id), cos(.37 id)] * mask
import sys, onnx
from onnx import helper, TensorProto
from tokenizers import Tokenizer, models, normalizers, pre_tokenizers, processors

out = sys.argv[1]
ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "seq"])
mask = helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "seq"])
types = helper.make_tensor_value_info("token_type_ids", TensorProto.INT64, ["batch", "seq"])
hidden = helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, ["batch", "seq", 4])
c = lambda name, v: helper.make_node("Constant", [], [name], value=helper.make_tensor(name + "_t", TensorProto.FLOAT, [1], [v]))
axes = helper.make_node("Constant", [], ["axes"], value=helper.make_tensor("axes_t", TensorProto.INT64, [1], [-1]))
nodes = [
  c("k1", 0.1), c("k2", 0.37), axes,
  helper.make_node("Cast", ["input_ids"], ["idf"], to=TensorProto.FLOAT),
  helper.make_node("Cast", ["attention_mask"], ["mf"], to=TensorProto.FLOAT),
  helper.make_node("Cast", ["token_type_ids"], ["tf"], to=TensorProto.FLOAT),
  # token types add nothing (times 0), but the input is used, like BERT's
  helper.make_node("Mul", ["tf", "zero"], ["t0"]),
  helper.make_node("Add", ["idf", "t0"], ["idt"]),
  helper.make_node("Mul", ["idt", "k1"], ["a"]),
  helper.make_node("Mul", ["idt", "k2"], ["b"]),
  helper.make_node("Sin", ["a"], ["s1"]), helper.make_node("Cos", ["a"], ["c1"]),
  helper.make_node("Sin", ["b"], ["s2"]), helper.make_node("Cos", ["b"], ["c2"]),
  *[helper.make_node("Unsqueeze", [x, "axes"], [x + "u"]) for x in ["s1", "c1", "s2", "c2", "mf"]],
  helper.make_node("Concat", ["s1u", "c1u", "s2u", "c2u"], ["feat"], axis=-1),
  helper.make_node("Mul", ["feat", "mfu"], ["last_hidden_state"]),
]
zero = helper.make_tensor("zero", TensorProto.FLOAT, [1], [0.0])
graph = helper.make_graph(nodes, "tiny-embedder", [ids, mask, types], [hidden], initializer=[zero])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], producer_name="epoch-tests")
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, out + "/model.onnx")

vocab = {t: i for i, t in enumerate(["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]",
  "src", "auth", "ui", "login", "session", "button", "icon", "token", "render",
  "export", "const", "function", "/", ".", "ts", "=", ";", "(", ")", "{", "}",
  "##s", "##ing", "##er", "1", "2", "the", "a"])}
tok = Tokenizer(models.WordPiece(vocab, unk_token="[UNK]"))
tok.normalizer = normalizers.BertNormalizer(lowercase=True)
tok.pre_tokenizer = pre_tokenizers.BertPreTokenizer()
tok.post_processor = processors.TemplateProcessing(single="[CLS] $A [SEP]", pair="[CLS] $A [SEP] $B [SEP]", special_tokens=[("[CLS]", 2), ("[SEP]", 3)])
tok.save(out + "/tokenizer.json")
