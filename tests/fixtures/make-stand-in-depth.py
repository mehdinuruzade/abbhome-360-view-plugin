"""Writes stand-in-depth.onnx: a tiny model with Depth Anything's input and output names and
shapes (pixel_values [1,3,H,W] -> predicted_depth [1,H,W]), returning mean brightness. It lets
the browser tests run the real onnxruntime-web path without downloading the 27 MB model."""
import pathlib
import onnx
from onnx import TensorProto, helper

x = helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, "h", "w"])
y = helper.make_tensor_value_info("predicted_depth", TensorProto.FLOAT, [1, "h", "w"])
node = helper.make_node("ReduceMean", ["pixel_values"], ["predicted_depth"], axes=[1], keepdims=0)
graph = helper.make_graph([node], "stand_in_depth", [x], [y])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="abb360-tests")
model.ir_version = 8
onnx.checker.check_model(model)
out = pathlib.Path(__file__).with_name("stand-in-depth.onnx")
onnx.save(model, out)
print(f"wrote {out} ({out.stat().st_size} bytes)")
