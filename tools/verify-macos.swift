// Decodes the PNGs listed in a manifest written by tools/verify-macos.mjs with two independent macOS decoders
// (CoreImage CIDetector and Vision VNDetectBarcodesRequest) and checks the decoded text equals the input.
import Foundation
import CoreImage
import Vision
let data = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let man = try! JSONSerialization.jsonObject(with: data) as! [[String: Any]]
var ok = 0, bad = 0
let det = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
for e in man {
  let f = e["f"] as! String, t = e["t"] as! String
  let img = CIImage(contentsOf: URL(fileURLWithPath: f))!
  var got: [String] = []
  for feat in det.features(in: img) { if let q = feat as? CIQRCodeFeature, let s = q.messageString { got.append("CI:" + s) } }
  let req = VNDetectBarcodesRequest(); req.symbologies = [.qr]
  try? VNImageRequestHandler(ciImage: img, options: [:]).perform([req])
  for r in req.results ?? [] { if let s = r.payloadStringValue { got.append("VN:" + s) } }
  let ciOK = got.contains("CI:" + t), vnOK = got.contains("VN:" + t)
  if ciOK || vnOK { ok += 1 } else { bad += 1 }
  print("\(ciOK ? "CI-ok" : "CI-no") \(vnOK ? "VN-ok" : "VN-no") v=\(e["v"]!) ecc=\(e["ecc"]!) mask=\(e["mask"]!) \(f.split(separator: "/").last!)")
}
print("TOTAL ok=\(ok) bad=\(bad)")
