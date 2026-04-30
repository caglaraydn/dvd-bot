import os
import sys

# Gereksiz uyarıları ve urllib3 OpenSSL uyarısını en başta sustur
os.environ['PYTHONWARNINGS'] = 'ignore'
import warnings
warnings.filterwarnings("ignore")

try:
    import urllib3
    urllib3.disable_warnings()
except ImportError:
    pass

from transformers import TrOCRProcessor, VisionEncoderDecoderModel
from PIL import Image

def solve_captcha(image_path):
    try:
        # Modeli yükle (İlk çalıştırmada indirilecektir)
        processor = TrOCRProcessor.from_pretrained('anuashok/ocr-captcha-v3', use_fast=True)
        model = VisionEncoderDecoderModel.from_pretrained('anuashok/ocr-captcha-v3')

        # Resmi yükle ve işle
        image = Image.open(image_path).convert("RGB")
        pixel_values = processor(images=image, return_tensors="pt").pixel_values

        # Tahmin et
        generated_ids = model.generate(pixel_values)
        generated_text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        
        return generated_text.strip()
    except Exception as e:
        return f"Hata: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Kullanım: python3 solver.py <resim_yolu>")
        sys.exit(1)
        
    img_path = sys.argv[1]
    result = solve_captcha(img_path)
    print(result)
