from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from enum import Enum


# ─── Enums ───────────────────────────────────────────────────────────────────

class DoseStatus(str, Enum):
    taken     = "taken"
    missed    = "missed"
    scheduled = "scheduled"
    snoozed   = "snoozed"
    skipped   = "skipped"


class FrequencyType(str, Enum):
    daily       = "daily"       # once a day
    twice_daily = "twice_daily" # twice a day
    three_times = "three_times" # three times a day
    weekly      = "weekly"
    custom      = "custom"      # specific days of week


class VerificationMethod(str, Enum):
    visual   = "visual"    # detected by camera
    manual   = "manual"    # user manually confirmed
    caregiver = "caregiver" # confirmed by caregiver


# ─── User Schemas ─────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    name: str
    email: str
    password: str
    role: str = "user"          # "user" or "caregiver"
    caregiver_ids: List[str] = []  # list of caregiver user IDs


class UserLogin(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: str
    name: str
    email: str
    role: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ─── Medication Schemas ───────────────────────────────────────────────────────

class MedicationCreate(BaseModel):
    name: str                           # e.g. "Aspirin"
    dosage: str                         # e.g. "500mg"
    frequency: FrequencyType
    scheduled_times: List[str]          # e.g. ["08:00", "20:00"]
    days_of_week: Optional[List[int]] = None  # 0=Mon, 6=Sun (for weekly/custom)
    instructions: Optional[str] = None  # e.g. "Take with food"
    start_date: datetime
    end_date: Optional[datetime] = None
    snooze_duration_minutes: int = 10
    caregiver_notify_on_miss: bool = True


class MedicationUpdate(BaseModel):
    name: Optional[str] = None
    dosage: Optional[str] = None
    frequency: Optional[FrequencyType] = None
    scheduled_times: Optional[List[str]] = None
    days_of_week: Optional[List[int]] = None
    instructions: Optional[str] = None
    end_date: Optional[datetime] = None
    snooze_duration_minutes: Optional[int] = None
    caregiver_notify_on_miss: Optional[bool] = None
    is_active: Optional[bool] = None


class MedicationResponse(BaseModel):
    id: str
    user_id: str
    name: str
    dosage: str
    frequency: FrequencyType
    scheduled_times: List[str]
    days_of_week: Optional[List[int]]
    instructions: Optional[str]
    start_date: datetime
    end_date: Optional[datetime]
    snooze_duration_minutes: int
    caregiver_notify_on_miss: bool
    is_active: bool
    created_at: datetime


# ─── Medication Log Schemas ───────────────────────────────────────────────────

class MedicationLogCreate(BaseModel):
    medication_id: str
    scheduled_time: datetime
    status: DoseStatus
    verification_method: Optional[VerificationMethod] = None
    notes: Optional[str] = None
    confidence_score: Optional[float] = None   # from camera detection (0.0 - 1.0)
    keyframe_id: Optional[str] = None          # linked keyframe from core module


class MedicationLogUpdate(BaseModel):
    status: DoseStatus
    verification_method: Optional[VerificationMethod] = None
    notes: Optional[str] = None
    taken_at: Optional[datetime] = None


class MedicationLogResponse(BaseModel):
    id: str
    user_id: str
    medication_id: str
    medication_name: str
    dosage: str
    scheduled_time: datetime
    taken_at: Optional[datetime]
    status: DoseStatus
    verification_method: Optional[VerificationMethod]
    notes: Optional[str]
    confidence_score: Optional[float]
    keyframe_id: Optional[str]
    created_at: datetime


# ─── Dashboard / Summary Schemas ─────────────────────────────────────────────

class DailyAdherenceSummary(BaseModel):
    date: str
    total_scheduled: int
    taken: int
    missed: int
    snoozed: int
    skipped: int
    adherence_percentage: float
    medications: List[MedicationLogResponse]


class MedicationScheduleItem(BaseModel):
    medication_id: str
    medication_name: str
    dosage: str
    scheduled_time: str
    status: DoseStatus
    instructions: Optional[str]
    snooze_duration_minutes: int