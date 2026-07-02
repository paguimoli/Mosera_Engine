using GamingEngine.Domain;
using System.Security.Cryptography;

namespace GamingEngine.Infrastructure;

public sealed class CryptoRandomNumberGenerator : IRandomNumberGenerator
{
    public int GetInt32(int exclusiveUpperBound)
    {
        return RandomNumberGenerator.GetInt32(exclusiveUpperBound);
    }
}
