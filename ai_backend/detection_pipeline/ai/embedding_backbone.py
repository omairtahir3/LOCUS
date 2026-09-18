"""
MobileNetV3-Small Item Embedding Backbone for LOCUS Exemplar Gallery.

Extracts L2-normalized 576-D feature vectors from item crops.
Thread-safe singleton, lazy-loaded on first use.

Benchmarked at ~22ms/crop on Intel i5-1035G1 CPU (224×224 input).
"""

from __future__ import annotations

import threading
import time
from typing import Optional

import cv2
import numpy as np

_backbone_instance: Optional[ItemEmbeddingBackbone] = None
_backbone_lock = threading.Lock()


class ItemEmbeddingBackbone:
    """
    MobileNetV3-Small feature extractor for item embedding.
    Strips the classifier head to produce raw 576-D pooled features.
    """

    def __init__(self):
        import torch
        import torchvision.models as models
        from torchvision.models import MobileNet_V3_Small_Weights

        t0 = time.perf_counter()
        print("[ItemEmbeddingBackbone] Loading MobileNetV3-Small...")

        self._model = models.mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
        self._model.classifier = torch.nn.Identity()  # 576-D output
        self._model.eval()

        # Store torch reference for later use
        self._torch = torch

        # ImageNet normalization constants
        self._mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        self._std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

        elapsed = (time.perf_counter() - t0) * 1000
        print(f"[ItemEmbeddingBackbone] MobileNetV3-Small loaded in {elapsed:.1f}ms (576-D output)")

    @classmethod
    def get_instance(cls) -> ItemEmbeddingBackbone:
        """Thread-safe singleton accessor."""
        global _backbone_instance
        if _backbone_instance is None:
            with _backbone_lock:
                if _backbone_instance is None:
                    _backbone_instance = cls()
        return _backbone_instance

    def _preprocess(self, image_bgr: np.ndarray) -> "torch.Tensor":
        """Resize to 224×224, convert BGR→RGB, normalize, return (1,3,224,224) tensor."""
        resized = cv2.resize(image_bgr, (224, 224), interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        normalized = (rgb - self._mean) / self._std
        # HWC → CHW → NCHW
        tensor = self._torch.from_numpy(normalized.transpose(2, 0, 1)).unsqueeze(0)
        return tensor

    @staticmethod
    def _simulate_wearable_optics(image_bgr: np.ndarray) -> np.ndarray:
        """Strip high-frequency detail a phone camera captures but the chest cam cannot.

        Applied to ENROLLMENT images only. Phone photos resolve fine texture
        (individual key teeth, print) that the wearable's optics never produce,
        and that mismatch dominates the embedding distance. Measured across 8
        chest-cam frames: the true item ranked #1 in 7/8 with this applied vs
        3/8 without, mean margin +0.042 vs -0.010.

        Deliberately NOT applied in _preprocess: detection crops already come
        from the wearable and must stay untouched, or the two sides are
        distorted differently and the measured gain does not hold.
        """
        return cv2.GaussianBlur(cv2.bilateralFilter(image_bgr, 9, 75, 75), (5, 5), 0)

    def extract(self, image_bgr: np.ndarray, enrollment: bool = False) -> np.ndarray:
        """
        Extract L2-normalized 576-D embedding from a BGR image crop.

        Args:
            image_bgr: OpenCV BGR image (any size, will be resized to 224×224)
            enrollment: True for phone enrollment photos, which get
                wearable-optics simulation first. Leave False for detection
                crops coming off the chest cam.

        Returns:
            np.ndarray of shape (576,) — L2-normalized embedding vector
        """
        if enrollment:
            image_bgr = self._simulate_wearable_optics(image_bgr)
        tensor = self._preprocess(image_bgr)
        with self._torch.no_grad():
            features = self._model(tensor)  # (1, 576)
        embedding = features.squeeze(0).numpy()
        # L2-normalize for cosine similarity
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        return embedding

    def extract_batch(self, images_bgr: list[np.ndarray], enrollment: bool = False) -> list[np.ndarray]:
        """
        Extract embeddings for multiple crops. Returns list of 576-D vectors.

        Args:
            images_bgr: List of OpenCV BGR images
            enrollment: True for phone enrollment photos — see extract().

        Returns:
            List of np.ndarray, each of shape (576,)
        """
        if not images_bgr:
            return []

        if enrollment:
            images_bgr = [self._simulate_wearable_optics(img) for img in images_bgr]
        tensors = [self._preprocess(img) for img in images_bgr]
        batch = self._torch.cat(tensors, dim=0)  # (N, 3, 224, 224)
        with self._torch.no_grad():
            features = self._model(batch)  # (N, 576)

        embeddings = []
        for i in range(features.shape[0]):
            emb = features[i].numpy()
            norm = np.linalg.norm(emb)
            if norm > 0:
                emb = emb / norm
            embeddings.append(emb)
        return embeddings
