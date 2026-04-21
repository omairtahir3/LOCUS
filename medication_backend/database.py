from motor.motor_asyncio import AsyncIOMotorClient
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    mongo_uri: str = "mongodb://localhost:27017"
    db_name: str = "locusDB"
    app_name: str = "MemoryAssist API"
    app_version: str = "1.0.0"
    debug: bool = True
    secret_key: str = "your_secret_key_change_this_in_production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 10080

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings():
    return Settings()


class Database:
    client: AsyncIOMotorClient = None
    db = None


db_instance = Database()


async def connect_db():
    """Connect to MongoDB on app startup."""
    settings = get_settings()
    db_instance.client = AsyncIOMotorClient(settings.mongo_uri)
    db_instance.db = db_instance.client[settings.db_name]

    # Create indexes for faster queries
    await db_instance.db.users.create_index("email", unique=True)
    await db_instance.db.medications.create_index("user_id")
    await db_instance.db.medication_logs.create_index([("user_id", 1), ("scheduled_time", -1)])
    await db_instance.db.medication_logs.create_index("medication_id")

    print(f"Connected to MongoDB: {settings.db_name}")


async def close_db():
    """Close MongoDB connection on app shutdown."""
    if db_instance.client:
        db_instance.client.close()
        print("MongoDB connection closed")


def get_db():
    """Dependency to get database instance in routes."""
    return db_instance.db