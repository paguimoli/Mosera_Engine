namespace GamingEngine.Domain;

public interface IRandomNumberGenerator
{
    int GetInt32(int exclusiveUpperBound);
}
