import os
import sys
import logging

# Hugging Face ve Transformers uyarılarını sustur
os.environ['TRANSFORMERS_VERBOSITY'] = 'error'
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'

import warnings
warnings.filterwarnings("ignore")

from transformers import TrOCRProcessor, VisionEncoderDecoderModel, logging as transformers_logging
transformers_logging.set_verbosity_error()
from PIL import Image

def solve_captcha(image_path):
    try:
        model_name = 'anuashok/ocr-captcha-v3'
        
        # İşlemciyi ve Modeli Yükle
        processor = TrOCRProcessor.from_pretrained(model_name)
        model = VisionEncoderDecoderModel.from_pretrained(model_name)

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
        sys.exit(1)
        
    img_path = sys.argv[1]
    result = solve_captcha(img_path)
    print(result)
